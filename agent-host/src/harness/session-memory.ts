// Pi 1.5.2 persists custom entries as branch metadata and custom messages as model input.
// Keep the first prompt with its branch. Content revisions are recorded with the message
// that actually delivers them, so restarting the Host or forking the branch replays both.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExtensionFactory, SessionManager } from '@earendil-works/pi-coding-agent';

import { isObject } from '../runtime/items.js';
import { resolveToolPath } from '../tools/paths.js';
import type { ToolProfile } from '../tools/profile.js';
import { anthropicMemoryPayload, MEMORY_MARKER } from './memory-wire.js';
import type { MemoryFile, MemorySnapshot } from '@piarc/protocol';
import type { ReadMemory } from './memory-io.js';
import { assembleSystem, IDENTITY, sourced, type FrozenSystem } from './prompts/system.js';

const INITIAL = 'piarc.systemPrompt';
const VISITED = 'piarc.memoryDirectories';
const UPDATE = 'piarc.memory';

function localDate(date: Date): string {
  const number = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${number(date.getMonth() + 1)}-${number(date.getDate())}`;
}

function digest(file: MemoryFile): string {
  return createHash('sha256').update(file.content).digest('hex');
}

/** Registered once per session. The registry prepares the Core snapshot before calling Pi:
 * an I/O failure must reach the turn owner, not be swallowed by an extension handler. */
export class SessionMemory {
  readonly #manager: SessionManager;
  readonly #cwd: string;
  readonly #profile: ToolProfile | undefined;
  readonly #read: ReadMemory | undefined;
  readonly #canonical: (name: string) => string;
  readonly #started: string;
  readonly #directories = new Set<string>();
  readonly #versions = new Map<string, string>();
  readonly #searches = new Map<string, string[]>();
  #date: string;
  #system: FrozenSystem | undefined;
  #snapshot: MemorySnapshot | undefined;
  #turnId: string | undefined;
  #preparing: AbortController | undefined;
  #lazy: Promise<void> = Promise.resolve();

  constructor(
    manager: SessionManager,
    cwd: string,
    profile: ToolProfile | undefined,
    read: ReadMemory | undefined,
    canonical: (name: string) => string,
  ) {
    this.#manager = manager;
    this.#cwd = cwd;
    this.#profile = profile;
    this.#read = read;
    this.#canonical = canonical;
    this.#started = localDate(new Date(manager.getHeader()?.timestamp ?? Date.now()));
    this.#date = this.#started;
    for (const entry of manager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === INITIAL && isObject(entry.data)) {
        if (typeof entry.data.system !== 'string') throw new Error('Invalid PiArc prompt record');
        const { system, cacheBoundary } = entry.data;
        // Older prompt records contain the frozen text alone.
        this.#system = {
          text: system,
          cacheBoundary:
            typeof cacheBoundary === 'number' ? cacheBoundary : system.indexOf('<project_context>'),
        };
        this.#apply(entry.data);
      } else if (entry.type === 'custom_message' && entry.customType === UPDATE) {
        this.#apply(entry.details);
      } else if (
        entry.type === 'custom' &&
        entry.customType === VISITED &&
        Array.isArray(entry.data)
      ) {
        for (const dir of entry.data) if (typeof dir === 'string') this.#directories.add(dir);
      }
    }
  }

  #apply(data: unknown): void {
    if (!isObject(data)) return;
    if (typeof data.date === 'string') this.#date = data.date;
    if (!isObject(data.versions)) return;
    for (const [name, hash] of Object.entries(data.versions)) {
      if (hash === null) this.#versions.delete(name);
      else if (typeof hash === 'string') this.#versions.set(name, hash);
    }
  }

  async prepare(turnId?: string): Promise<boolean> {
    this.#turnId = turnId;
    const controller = new AbortController();
    this.#preparing = controller;
    try {
      const snapshot = await this.#load(this.#system === undefined, controller.signal, turnId);
      if (controller.signal.aborted) return false;
      this.#snapshot = snapshot;
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      if (this.#preparing === controller) this.#preparing = undefined;
    }
  }

  cancel(): void {
    this.#preparing?.abort();
    this.#turnId = undefined;
    this.#snapshot = undefined;
  }

  #load(includeGit: boolean, signal?: AbortSignal, turnId?: string): Promise<MemorySnapshot> {
    return (
      this.#read?.([...this.#directories], includeGit, signal, turnId) ??
      Promise.resolve({ files: [] })
    );
  }

  /** Search tools report Core's structured matches before the formatted result is truncated. */
  searched = (id: string, directories: string[]): void => {
    this.#searches.set(id, directories);
  };

  #visit(tool: string, input: Record<string, unknown>, id: string): boolean {
    let directories = this.#searches.get(id);
    this.#searches.delete(id);
    if (directories === undefined) {
      if (!['Read', 'Write', 'Edit'].includes(tool) || typeof input.path !== 'string') return false;
      directories = [path.dirname(resolveToolPath(input.path, this.#cwd))];
    }
    const added: string[] = [];
    for (const dir of directories) {
      const relative = path.relative(this.#cwd, dir);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative)
      )
        continue;
      if (this.#directories.has(dir)) continue;
      this.#directories.add(dir);
      added.push(dir);
    }
    if (!added.length) return false;
    this.#manager.appendCustomEntry(VISITED, added);
    return true;
  }

  #update(files: readonly MemoryFile[], lazy: boolean) {
    const contents: string[] = [];
    const changes = new Map<string, string | null>();
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      const previous = this.#versions.get(file.path);
      if (lazy && previous !== undefined) continue;
      const hash = digest(file);
      if (hash !== previous) {
        changes.set(file.path, hash);
        contents.push(sourced(file));
      }
    }
    if (!lazy) {
      for (const name of this.#versions.keys()) {
        if (seen.has(name)) continue;
        changes.set(name, null);
        contents.push(`No longer loaded: ${name}`);
      }
    }
    const date = lazy ? this.#date : localDate(new Date());
    if (date !== this.#date) contents.push(`Current date: ${date}`);
    if (!contents.length) return undefined;
    const details = { date, versions: Object.fromEntries(changes) };
    this.#apply(details);
    return {
      customType: UPDATE,
      display: false,
      content: [MEMORY_MARKER, ...contents].join('\n\n'),
      details,
    };
  }

  extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async (event, ctx) => {
      const options = event.systemPromptOptions;
      // The persisted SDK loadout stays white-labelled as well. A forced prompt is used
      // for the exact provider bytes; Pi still diffs its own structured loadout on disk.
      options.customPrompt = IDENTITY;
      options.forceSystemPrompt = this.#system?.text ?? IDENTITY;
      let snapshot = this.#snapshot;
      this.#snapshot = undefined;
      // An extension can start its own turn without going through the registry.
      if (snapshot === undefined) {
        this.#turnId = undefined;
        snapshot = await this.#load(this.#system === undefined, ctx.signal);
      }
      if (this.#system === undefined) {
        const tools = options.selectedTools.filter((tool) => !options.hiddenTools.includes(tool));
        this.#system = assembleSystem(tools, this.#profile, snapshot.files, {
          cwd: this.#cwd,
          platform: process.platform,
          date: this.#started,
          ...(snapshot.gitStatus == null ? {} : { gitStatus: snapshot.gitStatus }),
        });
        const versions = Object.fromEntries(
          snapshot.files.map((file) => [file.path, digest(file)]),
        );
        this.#manager.appendCustomEntry(INITIAL, {
          system: this.#system.text,
          cacheBoundary: this.#system.cacheBoundary,
          date: this.#started,
          versions,
        });
        this.#apply({ versions });
      }
      const message = this.#update(snapshot.currentFiles ?? snapshot.files, false);
      return { systemPrompt: this.#system.text, ...(message === undefined ? {} : { message }) };
    });

    pi.on('before_provider_request', ({ payload }, ctx) =>
      ctx.model?.api === 'anthropic-messages'
        ? anthropicMemoryPayload(payload, this.#system)
        : undefined,
    );
    if (!this.#read) return;
    pi.on('tool_result', async (event, ctx) => {
      if (event.isError || ctx.signal?.aborted) {
        this.#searches.delete(event.toolCallId);
        return;
      }
      // Calls in a read-only tool batch can finish together. Serialize discovery and
      // publication, and never mark another call's files as already delivered.
      const turnId = this.#turnId;
      const publish = async (): Promise<void> => {
        if (!this.#visit(this.#canonical(event.toolName), event.input, event.toolCallId)) return;
        const snapshot = await this.#load(false, ctx.signal, turnId);
        ctx.signal?.throwIfAborted();
        const message = this.#update(snapshot.files, true);
        // Pi 1.5.2 flushes these messages immediately after the complete tool-result batch,
        // before constructing the next provider request. The user's steer queue is separate.
        if (message) pi.sendMessage(message, { triggerTurn: false });
      };
      this.#lazy = this.#lazy.then(publish, publish);
      await this.#lazy;
    });
  };
}
