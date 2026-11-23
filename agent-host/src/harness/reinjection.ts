// What a compaction gives back (architecture sections 6.6.4 and 6.15, T27, ADR-0043 rule 7):
// one `contextRestore` reminder message with memory, the approved plan, the task list, the
// instructions of invoked skills and recently used files, within the limits below. Tokens are
// counted with the usage estimate (tokens.ts).
import path from 'node:path';

import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { PlanRecord, TodoItem } from '@piarc/protocol';

import { isObject } from '../runtime/items.js';
import { resolveToolPath } from '../tools/paths.js';
import {
  cutNote,
  omittedFiles,
  RESTORE_INTRO,
  restoredFile,
  restoredPlan,
  restoredSkill,
  restoredTodos,
} from './prompts/notices.js';
import { restoredMemory } from './prompts/auto-memory.js';
import type { KeyedReminder, ReminderCategory } from './reminders.js';
import { estimateTokens, truncateToTokens } from './tokens.js';

/** Token limits of what a compaction gives back: each item and each kind in total. */
export const RESTORE_LIMITS = {
  memoryFile: 10_000,
  memoryTotal: 20_000,
  plan: 10_000,
  todos: 2_000,
  skill: 5_000,
  skillsTotal: 25_000,
  /** The most recently used files considered. */
  files: 5,
  file: 20_000,
  filesTotal: 50_000,
  /** Auto memory notes the session read or saved (T47): the most recent ones, together. */
  notes: 5,
  notesTotal: 10_000,
} as const;

/** Custom entry of an invoked skill (`{ name, content }`): T37's Skill tool writes it. */
export const SKILL_ENTRY = 'piarc.skillInvoked';

export interface InvokedSkill {
  readonly name: string;
  readonly content: string;
}

/** The skills invoked on the branch, most recent first, the latest invocation of each. */
export function invokedSkills(entries: readonly SessionEntry[]): InvokedSkill[] {
  const skills = new Map<string, InvokedSkill>();
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'custom' || entry.customType !== SKILL_ENTRY || !isObject(entry.data)) {
      continue;
    }
    const { name, content } = entry.data;
    if (typeof name !== 'string' || typeof content !== 'string' || skills.has(name)) continue;
    skills.set(name, { name, content });
  }
  return [...skills.values()];
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

/** The files the branch's Read, Write and Edit calls used, most recent first, each once (as
 * the model wrote it; `cwd` decides what counts as the same file). */
export function recentFiles(
  entries: readonly SessionEntry[],
  canonical: (tool: string) => string,
  cwd: string,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    for (const part of entry.message.content.toReversed()) {
      if (part.type !== 'toolCall' || !FILE_TOOLS.has(canonical(part.name))) continue;
      const target = part.arguments.path;
      if (typeof target !== 'string' || target.length === 0) continue;
      const resolved = path.normalize(resolveToolPath(target, cwd));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      files.push(target);
    }
  }
  return files;
}

/** The auto memory notes the branch's `Memory` calls read or saved, most recent first, each
 * once (T47). */
export function recentNotes(
  entries: readonly SessionEntry[],
  canonical: (tool: string) => string,
): string[] {
  const notes: string[] = [];
  for (const entry of entries.toReversed()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    for (const part of entry.message.content.toReversed()) {
      if (part.type !== 'toolCall' || canonical(part.name) !== 'Memory') continue;
      const { action, name } = part.arguments;
      if ((action !== 'read' && action !== 'save') || typeof name !== 'string') continue;
      if (name.length > 0 && !notes.includes(name)) notes.push(name);
    }
  }
  return notes;
}

/** A file read for a restore: its text, too long for the limit, or not readable. */
export type RestoredRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tooLong' }
  | { readonly kind: 'unreadable' };

export interface RestoreSources {
  /** Memory sections from `SessionMemory.restore`, not yet limited. */
  readonly memory: readonly KeyedReminder[];
  readonly plan: PlanRecord | undefined;
  readonly todos: readonly TodoItem[];
  readonly skills: readonly InvokedSkill[];
  /** Recently used files, most recent first. */
  readonly files: readonly string[];
  /** A file's current text, at most `maxChars` UTF-16 code units of it. */
  readonly readFile: (file: string, maxChars: number) => Promise<RestoredRead>;
  /** Auto memory notes the branch read or saved, most recent first (T47). */
  readonly notes?: readonly string[];
  /** A note as Core reads it now, or undefined when it is gone or auto memory is off. */
  readonly readNote?: (name: string) => Promise<string | undefined>;
}

function section(
  key: string,
  source: string,
  text: string,
  category: ReminderCategory,
): KeyedReminder {
  return { key, type: 'contextRestore', source, text, category };
}

/** `items` limited to `each` tokens apiece and `total` together; what does not fit at all
 * is left out. */
function limited(items: readonly KeyedReminder[], each: number, total: number): KeyedReminder[] {
  const kept: KeyedReminder[] = [];
  let left = total;
  for (const item of items) {
    const budget = Math.min(each, left);
    if (budget <= 0) break;
    const { text } = truncateToTokens(item.text, budget, cutNote);
    kept.push({ ...item, text });
    left -= estimateTokens(text);
  }
  return kept;
}

/** The sections of the restore message, in order, within `RESTORE_LIMITS`. */
export async function restoreSections(sources: RestoreSources): Promise<KeyedReminder[]> {
  const sections: KeyedReminder[] = [
    section('restore:intro', 'compaction', RESTORE_INTRO, 'conversation'),
    ...limited(sources.memory, RESTORE_LIMITS.memoryFile, RESTORE_LIMITS.memoryTotal),
  ];
  if (sources.plan !== undefined) {
    const text = restoredPlan(sources.plan.plan, sources.plan.mode);
    sections.push(
      section(
        'restore:plan',
        'plan',
        truncateToTokens(text, RESTORE_LIMITS.plan, cutNote).text,
        'conversation',
      ),
    );
  }
  if (sources.todos.length > 0) {
    const text = truncateToTokens(restoredTodos(sources.todos), RESTORE_LIMITS.todos, cutNote);
    sections.push(section('restore:todos', 'TodoWrite', text.text, 'conversation'));
  }
  sections.push(
    ...limited(
      sources.skills.map((skill) =>
        section(
          `restore:skill:${skill.name}`,
          skill.name,
          restoredSkill(skill.name, skill.content),
          'skills',
        ),
      ),
      RESTORE_LIMITS.skill,
      RESTORE_LIMITS.skillsTotal,
    ),
  );
  const notes: KeyedReminder[] = [];
  for (const name of (sources.notes ?? []).slice(0, RESTORE_LIMITS.notes)) {
    const text = await sources.readNote?.(name);
    if (text !== undefined) {
      notes.push(section(`restore:note:${name}`, name, restoredMemory(text), 'memory'));
    }
  }
  sections.push(...limited(notes, RESTORE_LIMITS.notesTotal, RESTORE_LIMITS.notesTotal));
  let left: number = RESTORE_LIMITS.filesTotal;
  const omitted: string[] = [];
  for (const file of sources.files.slice(0, RESTORE_LIMITS.files)) {
    const read = await sources.readFile(file, RESTORE_LIMITS.file * 4);
    if (read.kind === 'unreadable') continue;
    if (read.kind === 'tooLong') {
      omitted.push(file);
      continue;
    }
    const text = restoredFile(file, read.text);
    const tokens = estimateTokens(text);
    if (tokens > RESTORE_LIMITS.file || tokens > left) {
      omitted.push(file);
      continue;
    }
    left -= tokens;
    sections.push(section(`restore:file:${file}`, file, text, 'conversation'));
  }
  if (omitted.length > 0) {
    sections.push(section('restore:omitted', 'files', omittedFiles(omitted), 'conversation'));
  }
  return sections;
}
