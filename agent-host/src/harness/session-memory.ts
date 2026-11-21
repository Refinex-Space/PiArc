// Pi 1.5.2 persists custom entries as branch metadata and custom messages as model input.
// Keep the first prompt with its branch. Content revisions are recorded with the reminder
// that actually delivers them (`piarc.reminder` details, T27; `piarc.memory` before it), so
// restarting the Host or forking the branch replays both. Memory loaded after the system
// prompt goes through the reminder channel: `memoryLazyLoad` (a subdirectory's file, a
// changed or removed file, the date) and `rulesMatched` (a `paths:` rule).
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExtensionFactory, SessionManager } from '@earendil-works/pi-coding-agent';

import { isObject } from '../runtime/items.js';
import { resolveToolPath } from '../tools/paths.js';
import type { ToolProfile } from '../tools/profile.js';
import { anthropicMemoryPayload } from './memory-wire.js';
import type { MemoryFile, MemorySnapshot } from '@piarc/protocol';
import type { ReadMemory } from './memory-io.js';
import {
  assembleSystem,
  IDENTITY,
  sourced,
  type FrozenSystem,
  type Persona,
} from './prompts/system.js';
import {
  REMINDER_ENTRY,
  reminderRecords,
  type KeyedReminder,
  type Reminders,
} from './reminders.js';

const INITIAL = 'piarc.systemPrompt';
const VISITED = 'piarc.memoryDirectories';
// Memory updates before T27 (`[PiArc memory]` messages); read for their versions only.
const UPDATE = 'piarc.memory';
// Conditional rules (`paths:`) loaded in this branch: they stay loaded (T24).
const RULES = 'piarc.memoryRules';

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
  readonly #reminders: Reminders;
  readonly #started: string;
  /** The memory files of the frozen system prompt and their digests. */
  readonly #initial = new Map<string, string>();
  readonly #directories = new Set<string>();
  readonly #rules = new Set<string>();
  readonly #versions = new Map<string, string>();
  readonly #searches = new Map<string, string[]>();
  #date: string;
  #system: FrozenSystem | undefined;
  #snapshot: MemorySnapshot | undefined;
  #turnId: string | undefined;
  #preparing: AbortController | undefined;
  #lazy: Promise<void> = Promise.resolve();
  /** Core's last answer: some conditional rule could still load on a file access. */
  #inactiveRules = false;
  /** A subagent's identity and context choice (T31). */
  readonly #persona: Persona | undefined;

  constructor(
    manager: SessionManager,
    cwd: string,
    profile: ToolProfile | undefined,
    read: ReadMemory | undefined,
    canonical: (name: string) => string,
    reminders: Reminders,
    persona?: Persona,
  ) {
    this.#manager = manager;
    this.#cwd = cwd;
    this.#profile = profile;
    // Without project context there is no memory to load, now or lazily.
    this.#read = persona?.projectContext === false ? undefined : read;
    this.#persona = persona;
    this.#canonical = canonical;
    this.#reminders = reminders;
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
        this.#remember(entry.data);
      } else if (entry.type === 'custom_message' && entry.customType === UPDATE) {
        this.#apply(entry.details);
      } else if (entry.type === 'custom_message' && entry.customType === REMINDER_ENTRY) {
        for (const record of reminderRecords(entry.details)) this.#apply(record.data);
      } else if (
        entry.type === 'custom' &&
        entry.customType === VISITED &&
        Array.isArray(entry.data)
      ) {
        for (const dir of entry.data) if (typeof dir === 'string') this.#directories.add(dir);
      } else if (
        entry.type === 'custom' &&
        entry.customType === RULES &&
        Array.isArray(entry.data)
      ) {
        for (const rule of entry.data) if (typeof rule === 'string') this.#rules.add(rule);
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

  /** The frozen system prompt, once the first run assembled it. */
  get systemText(): string | undefined {
    return this.#system?.text;
  }

  /** The versions the frozen system prompt was built from. */
  #remember(data: unknown): void {
    if (!isObject(data) || !isObject(data.versions)) return;
    for (const [name, hash] of Object.entries(data.versions)) {
      if (typeof hash === 'string') this.#initial.set(name, hash);
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

  async #load(
    includeGit: boolean,
    signal?: AbortSignal,
    turnId?: string,
    files: string[] = [],
  ): Promise<MemorySnapshot> {
    if (!this.#read) return { files: [] };
    const snapshot = await this.#read([...this.#directories], includeGit, signal, turnId, {
      files,
      rules: [...this.#rules],
    });
    this.#inactiveRules = snapshot.inactiveRules === true;
    const loaded = (snapshot.currentFiles ?? snapshot.files)
      .filter((file) => file.paths != null && !this.#rules.has(file.path))
      .map((file) => file.path);
    if (loaded.length) {
      for (const rule of loaded) this.#rules.add(rule);
      this.#manager.appendCustomEntry(RULES, loaded);
    }
    return snapshot;
  }

  /** Search tools report Core's structured matches before the formatted result is truncated. */
  searched = (id: string, directories: string[]): void => {
    this.#searches.set(id, directories);
  };

  /** Records newly visited directories; returns them and the file a file tool touched. */
  #visit(
    tool: string,
    input: Record<string, unknown>,
    id: string,
  ): { added: boolean; file?: string } {
    let directories = this.#searches.get(id);
    this.#searches.delete(id);
    let file: string | undefined;
    if (directories === undefined) {
      if (!['Read', 'Write', 'Edit'].includes(tool) || typeof input.path !== 'string')
        return { added: false };
      file = resolveToolPath(input.path, this.#cwd);
      directories = [path.dirname(file)];
    }
    const touched = file === undefined ? {} : { file };
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
    if (!added.length) return { added: false, ...touched };
    this.#manager.appendCustomEntry(VISITED, added);
    return { added: true, ...touched };
  }

  /** Queues the memory that changed since it was last delivered; whether anything did. */
  #update(files: readonly MemoryFile[], lazy: boolean): boolean {
    const queued: KeyedReminder[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      const previous = this.#versions.get(file.path);
      if (lazy && previous !== undefined) continue;
      const hash = digest(file);
      if (hash !== previous) {
        queued.push({
          key: `memory:${file.path}`,
          type: file.paths == null ? 'memoryLazyLoad' : 'rulesMatched',
          source: file.path,
          text: sourced(file),
          category: 'memory',
          data: { versions: { [file.path]: hash } },
        });
      }
    }
    if (!lazy) {
      for (const name of this.#versions.keys()) {
        if (seen.has(name)) continue;
        queued.push({
          key: `memory:${name}`,
          type: 'memoryLazyLoad',
          source: name,
          text: `No longer loaded: ${name}`,
          category: 'memory',
          data: { versions: { [name]: null } },
        });
      }
    }
    const date = lazy ? this.#date : localDate(new Date());
    if (date !== this.#date) {
      queued.push({
        key: 'memory:date',
        type: 'memoryLazyLoad',
        source: 'date',
        text: `Current date: ${date}`,
        data: { date },
      });
    }
    for (const { key, ...reminder } of queued) {
      this.#apply(reminder.data);
      this.#reminders.enqueue(key, reminder);
    }
    return queued.length > 0;
  }

  /**
   * After a compaction (T27): the memory the system prompt does not hold as it is now, read
   * from disk again (subdirectory files, `paths:` rules, files changed since the prompt was
   * frozen, removed files) as `contextRestore` reminders; the earlier reminders were
   * summarized away.
   */
  async restore(signal?: AbortSignal): Promise<KeyedReminder[]> {
    if (!this.#read) return [];
    const snapshot = await this.#load(false, signal);
    const files = snapshot.currentFiles ?? snapshot.files;
    const restored: KeyedReminder[] = [];
    const present = new Set<string>();
    for (const file of files) {
      present.add(file.path);
      const hash = digest(file);
      if (this.#initial.get(file.path) === hash) continue;
      restored.push({
        key: `memory:${file.path}`,
        type: 'contextRestore',
        source: file.path,
        text: sourced(file),
        category: 'memory',
        data: { versions: { [file.path]: hash } },
      });
    }
    for (const name of this.#initial.keys()) {
      if (present.has(name)) continue;
      restored.push({
        key: `memory:${name}`,
        type: 'contextRestore',
        source: name,
        text: `No longer loaded: ${name}`,
        category: 'memory',
        data: { versions: { [name]: null } },
      });
    }
    if (this.#date !== this.#started) {
      restored.push({
        key: 'memory:date',
        type: 'contextRestore',
        source: 'date',
        text: `Current date: ${this.#date}`,
      });
    }
    return restored;
  }

  /** Records the versions a restore delivered. */
  restored(reminders: readonly KeyedReminder[]): void {
    for (const reminder of reminders) this.#apply(reminder.data);
  }

  /** The MCP section of the system prompt (T36), read when the system prompt is frozen. */
  mcpSection: (() => string | undefined) | undefined;

  /** The output style and skills index sections (T37), read when the prompt is frozen. */
  skillSections:
    ((signal?: AbortSignal) => Promise<{ style?: string; skills?: string }>) | undefined;

  extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async (event, ctx) => {
      const options = event.systemPromptOptions;
      // The persisted SDK loadout stays white-labelled as well. A forced prompt is used
      // for the exact provider bytes; Pi still diffs its own structured loadout on disk.
      const identity = this.#persona?.identity ?? IDENTITY;
      options.customPrompt = identity;
      options.forceSystemPrompt = this.#system?.text ?? identity;
      let snapshot = this.#snapshot;
      this.#snapshot = undefined;
      // An extension can start its own turn without going through the registry.
      if (snapshot === undefined) {
        this.#turnId = undefined;
        snapshot = await this.#load(this.#system === undefined, ctx.signal);
      }
      if (this.#system === undefined) {
        // `options` is Pi's copy from before the handlers ran: a whole-tool deny that the
        // policy gate applied with setActiveTools() is only in the live tool set (R3).
        const active = new Set(pi.getActiveTools());
        const tools = options.selectedTools.filter(
          (tool) => active.has(tool) && !options.hiddenTools.includes(tool),
        );
        const skills = await this.skillSections?.(ctx.signal);
        this.#system = assembleSystem(
          tools,
          this.#profile,
          snapshot.files,
          {
            cwd: this.#cwd,
            platform: process.platform,
            date: this.#started,
            ...(snapshot.gitStatus == null ? {} : { gitStatus: snapshot.gitStatus }),
          },
          this.#persona,
          this.mcpSection?.(),
          skills,
        );
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
        this.#remember({ versions });
      }
      // The reminders extension, registered after this one, delivers what this queues.
      this.#update(snapshot.currentFiles ?? snapshot.files, false);
      return { systemPrompt: this.#system.text };
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
        const visit = this.#visit(this.#canonical(event.toolName), event.input, event.toolCallId);
        // A file access matters to Core when it could load a conditional rule.
        const file = this.#inactiveRules ? visit.file : undefined;
        if (!visit.added && file === undefined) return;
        const snapshot = await this.#load(
          false,
          ctx.signal,
          turnId,
          file === undefined ? [] : [file],
        );
        ctx.signal?.throwIfAborted();
        // Delivered with this round's other reminders after its tool results (`turn_end`).
        this.#update(snapshot.files, true);
      };
      this.#lazy = this.#lazy.then(publish, publish);
      await this.#lazy;
    });
  };
}
