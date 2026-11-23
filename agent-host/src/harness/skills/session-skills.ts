// One session's skills and output style (T37, ADR-0054): what the system prompt's sections 3
// and 5 hold, what changed since, the `paths` skills a file made available, and the loads of
// the `Skill` tool.
//
// - The catalog comes from Core (`skills/list` with the session's id: Core then lets the
//   session's file tools read the skills' directories). It is kept until Core says files or
//   settings changed (`resources/reload`, `invalidate`) and read again before the next run.
// - The index lists the skills the model may load: not `disable-model-invocation`, not hidden
//   by `skillOverrides` or a `Skill` deny rule, and for a `paths` skill only once a Read, Write
//   or Edit touched a matching file (`skills/match`). Each description is cut to
//   `SKILL_INDEX_DESCRIPTION_CHARS`.
// - Branch entries keep what the model knows: `piarc.skillsIndex` (the index lines last given),
//   `piarc.skillsActive` (`paths` skills made available), `piarc.outputStyle` (the style last
//   given). Changes go out as `skillsChanged` and `outputStyle` reminders before the next run;
//   the frozen system prompt never changes.
// - Loads: `piarc.skillInvoked` (`{ name, content }`), the entry T27's compaction gives back.
import { createHash } from 'node:crypto';

import type {
  ExtensionFactory,
  SessionEntry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { PromptCommand, SkillInfo, SkillsCatalog } from '@piarc/protocol';

import { runDelegation, type AgentToolHost } from '../subagents/agent-tool.js';
import { isObject } from '../../runtime/items.js';
import type { CoreBridge } from '../../runtime/core-bridge.js';
import { resolveToolPath } from '../../tools/paths.js';
import { styleChanged, styleInstructions, styleSection } from '../prompts/output-styles.js';
import {
  SKILLS_INDEX_INTRO,
  SKILL_UNTRUSTED_NOTE,
  skillAllowedNote,
  skillAlreadyLoaded,
  skillLine,
  skillLoaded,
  skillsChanged,
} from '../prompts/skills.js';
import { SKILL_ENTRY } from '../reinjection.js';
import type { Reminders } from '../reminders.js';
import { parseInvokeResult, parseMatchResult, parseSkillsCatalog } from './catalog.js';

/** Longest description in the index (Claude Code's limit). */
export const SKILL_INDEX_DESCRIPTION_CHARS = 1_536;

/** The index lines the model last received. */
export const INDEX_ENTRY = 'piarc.skillsIndex';
/** `paths` skills a touched file made available. */
export const ACTIVE_ENTRY = 'piarc.skillsActive';
/** The output style the model last received (`{ name, digest }`). */
export const STYLE_ENTRY = 'piarc.outputStyle';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

/** One skill as the index gives it. */
interface IndexLine {
  readonly name: string;
  readonly line: string;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SKILL_INDEX_DESCRIPTION_CHARS
    ? `${flat.slice(0, SKILL_INDEX_DESCRIPTION_CHARS - 1)}…`
    : flat;
}

/** The last entry of `type` on the branch. */
function lastData(entries: readonly SessionEntry[], type: string): unknown {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === 'custom' && entry.customType === type) return entry.data;
  }
  return undefined;
}

export interface SessionSkillsOptions {
  readonly agents?: AgentToolHost;
  readonly sessionId: string;
  readonly manager: SessionManager;
  readonly bridge: CoreBridge;
  readonly reminders: Reminders;
  readonly canonical: (tool: string) => string;
  readonly cwd: string;
  readonly log: (line: string) => void;
}

/** The result of a `Skill` load. */
export interface SkillLoad {
  readonly text: string;
  readonly name: string;
}

export class SessionSkills {
  readonly #o: SessionSkillsOptions;
  #catalog: SkillsCatalog | undefined;
  #stale = true;
  #loading: Promise<SkillsCatalog | undefined> | undefined;
  readonly #active = new Set<string>();
  #matching: Promise<void> = Promise.resolve();

  constructor(options: SessionSkillsOptions) {
    this.#o = options;
    for (const entry of options.manager.getBranch()) {
      if (
        entry.type === 'custom' &&
        entry.customType === ACTIVE_ENTRY &&
        Array.isArray(entry.data)
      ) {
        for (const name of entry.data) if (typeof name === 'string') this.#active.add(name);
      }
    }
  }

  /** Core says skill, command, style or settings files changed: read them before the next run. */
  invalidate(): void {
    this.#stale = true;
  }

  /** The catalog, read from Core when it is stale. A failed read keeps the last one. */
  async catalog(signal?: AbortSignal): Promise<SkillsCatalog | undefined> {
    if (!this.#stale && this.#catalog !== undefined) return this.#catalog;
    this.#loading ??= this.#o.bridge
      .requestTyped(
        'skills/list',
        { sessionId: this.#o.sessionId },
        parseSkillsCatalog,
        signal === undefined ? undefined : { signal },
      )
      .then(
        (catalog) => {
          this.#catalog = catalog;
          this.#stale = false;
          return catalog;
        },
        (error: unknown) => {
          this.#o.log(
            `[session ${this.#o.sessionId}] skills/list failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return this.#catalog;
        },
      )
      .finally(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }

  /** Whether the model has any skill to load (the session registers `Skill` then). */
  get modelSkills(): boolean {
    return (this.#catalog?.skills ?? []).some((s) => s.modelInvocable);
  }

  #visible(skill: SkillInfo): boolean {
    return (
      skill.modelInvocable &&
      (skill.paths == null || skill.paths.length === 0 || this.#active.has(skill.name))
    );
  }

  /** The index entries of the skills the model may load now. */
  #index(): IndexLine[] {
    return (this.#catalog?.skills ?? [])
      .filter((skill) => this.#visible(skill))
      .map((skill) => ({
        name: skill.name,
        line: skillLine(
          skill.name,
          skill.visibility === 'nameOnly' ? undefined : oneLine(skill.description),
        ),
      }));
  }

  /** What the model last heard about the index, and the entries since added and removed. */
  #diff(): { now: IndexLine[]; added: string[]; removed: string[] } {
    const known = lastData(this.#o.manager.getBranch(), INDEX_ENTRY);
    const before: IndexLine[] =
      isObject(known) && Array.isArray(known.skills)
        ? known.skills.flatMap((e: unknown) =>
            isObject(e) && typeof e.name === 'string' && typeof e.line === 'string'
              ? [{ name: e.name, line: e.line }]
              : [],
          )
        : [];
    const now = this.#index();
    return {
      now,
      added: now.filter((e) => !before.some((b) => b.line === e.line)).map((e) => e.line),
      removed: before.filter((b) => !now.some((e) => e.name === b.name)).map((b) => b.name),
    };
  }

  #style(): { name: string; instructions: string | undefined } {
    const catalog = this.#catalog;
    const name = catalog?.outputStyle.name ?? 'Default';
    const custom = catalog?.outputStyles.find((s) => s.name === name)?.instructions ?? undefined;
    return { name, instructions: styleInstructions(name, custom) };
  }

  /**
   * The system prompt's output style (section 3) and skills index (section 5), when the
   * prompt is frozen; records them as what the model knows.
   */
  async sections(signal?: AbortSignal): Promise<{ style?: string; skills?: string }> {
    await this.catalog(signal);
    const index = this.#index();
    const lines = index.map((e) => e.line);
    const style = this.#style();
    this.#o.manager.appendCustomEntry(INDEX_ENTRY, { skills: index });
    this.#o.manager.appendCustomEntry(STYLE_ENTRY, {
      name: style.name,
      digest: digest(style.instructions ?? ''),
    });
    return {
      ...(style.instructions === undefined
        ? {}
        : { style: styleSection(style.name, style.instructions) }),
      ...(lines.length === 0 ? {} : { skills: [SKILLS_INDEX_INTRO, ...lines].join('\n') }),
    };
  }

  /** Before a run: what changed since the model last heard goes out as reminders. */
  async #update(signal?: AbortSignal): Promise<void> {
    if (this.#stale) await this.catalog(signal);
    if (this.#catalog === undefined) return;
    const { now, added, removed } = this.#diff();
    if (added.length > 0 || removed.length > 0) {
      this.#o.reminders.enqueue('skills:index', {
        type: 'skillsChanged',
        source: 'skills',
        text: skillsChanged(added, removed),
        category: 'skills',
      });
      this.#o.manager.appendCustomEntry(INDEX_ENTRY, { skills: now });
    }
    const branch = this.#o.manager.getBranch();
    const style = this.#style();
    const last = lastData(branch, STYLE_ENTRY);
    const styleDigest = digest(style.instructions ?? '');
    const lastName = isObject(last) && typeof last.name === 'string' ? last.name : 'Default';
    const lastDigest = isObject(last) && typeof last.digest === 'string' ? last.digest : digest('');
    if (lastName !== style.name || lastDigest !== styleDigest) {
      this.#o.reminders.enqueue('style', {
        type: 'outputStyle',
        source: style.name,
        text: styleChanged(style.name, style.instructions),
      });
      this.#o.manager.appendCustomEntry(STYLE_ENTRY, { name: style.name, digest: styleDigest });
    }
  }

  /** The skills a touched file makes available (`skills/match`), told to the model. */
  async #touched(file: string, signal?: AbortSignal): Promise<void> {
    const pending = (this.#catalog?.skills ?? [])
      .filter((s) => s.modelInvocable && (s.paths?.length ?? 0) > 0 && !this.#active.has(s.name))
      .map((s) => s.name);
    if (pending.length === 0) return;
    const result = await this.#o.bridge.requestTyped(
      'skills/match',
      { sessionId: this.#o.sessionId, files: [file], skills: pending },
      parseMatchResult,
      signal === undefined ? undefined : { signal },
    );
    const matched = (result.matched ?? []).filter((name) => !this.#active.has(name));
    if (matched.length === 0) return;
    for (const name of matched) this.#active.add(name);
    this.#o.manager.appendCustomEntry(ACTIVE_ENTRY, matched);
    const { now, added } = this.#diff();
    if (added.length === 0) return;
    this.#o.reminders.enqueue('skills:paths', {
      type: 'skillsChanged',
      source: file,
      text: skillsChanged(added, []),
      category: 'skills',
    });
    this.#o.manager.appendCustomEntry(INDEX_ENTRY, { skills: now });
  }

  /** The `Skill` tool's load of `name` in call `toolCallId`. */
  async load(
    toolCallId: string,
    name: string,
    args: string | undefined,
    signal?: AbortSignal,
  ): Promise<SkillLoad> {
    const result = await this.#o.bridge.requestTyped(
      'skills/invoke',
      {
        sessionId: this.#o.sessionId,
        toolCallId,
        name,
        ...(args === undefined || args === '' ? {} : { arguments: args }),
      },
      parseInvokeResult,
      signal === undefined ? undefined : { signal },
    );
    if (result.fork) {
      const text = await runDelegation(
        this.#o.agents,
        result.fork,
        toolCallId,
        `/${result.name}`,
        result.content,
        signal,
      );
      return { name: result.name, text };
    }
    const already = this.#o.manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === SKILL_ENTRY &&
          isObject(entry.data) &&
          entry.data.name === result.name &&
          entry.data.content === result.content,
      );
    if (already) return { name: result.name, text: skillAlreadyLoaded(result.name) };
    this.#o.manager.appendCustomEntry(SKILL_ENTRY, { name: result.name, content: result.content });
    const notes: string[] = [];
    if ((result.warnings ?? []).some((w) => w.kind === 'untrusted'))
      notes.push(SKILL_UNTRUSTED_NOTE);
    if ((result.allowedTools ?? []).length > 0)
      notes.push(skillAllowedNote(result.allowedTools ?? []));
    return { name: result.name, text: skillLoaded(result.name, result.dir, result.content, notes) };
  }

  /** The user started a skill with `/name`: its text is the message, kept for compactions. */
  invokedByUser(command: PromptCommand, text: string): void {
    if (command.kind !== 'skill' || command.fork) return;
    this.#o.manager.appendCustomEntry(SKILL_ENTRY, { name: command.name, content: text });
  }

  extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async (_event, ctx) => {
      // Registered after the memory extension, which froze the prompt with `sections()`.
      await this.#update(ctx.signal);
    });
    pi.on('tool_result', async (event, ctx) => {
      if (event.isError || ctx.signal?.aborted) return;
      if (!FILE_TOOLS.has(this.#o.canonical(event.toolName))) return;
      const path = event.input.path;
      if (typeof path !== 'string') return;
      const file = resolveToolPath(path, this.#o.cwd);
      // Calls of one batch finish together: match one file at a time.
      const run = async (): Promise<void> => {
        try {
          await this.#touched(file, ctx.signal);
        } catch (error) {
          this.#o.log(
            `[session ${this.#o.sessionId}] skills/match failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      this.#matching = this.#matching.then(run, run);
      await this.#matching;
    });
  };
}
