// The Git panel's pure logic (ADR-0084): the scope a session shows and the display choices
// (remembered in this window's storage), the changed files as a tree or a flat list grouped by
// kind, side-by-side pairing, the unchanged lines between hunks, and changed words.
import type { DiffHunk, DiffLine } from '@piarc/protocol';

import type { CommitRow, FileChange, Scope } from './protocol.js';

// ---- Scope ----

/** What the Changes view shows: a Git range, or the session's own writes (ADR-0084 rule 1). */
export type ScopeChoice =
  | { readonly kind: 'branch'; readonly base?: string | undefined }
  | { readonly kind: 'uncommitted' }
  | {
      readonly kind: 'commit';
      readonly sha: string;
      readonly short: string;
      readonly subject: string;
    }
  | { readonly kind: 'session' };

export const DEFAULT_SCOPE: ScopeChoice = { kind: 'branch' };

/** The Git request scope of a choice; none for the session's own changes. */
export function gitScope(choice: ScopeChoice): Scope | undefined {
  switch (choice.kind) {
    case 'branch':
      return choice.base === undefined ? { kind: 'branch' } : { kind: 'branch', base: choice.base };
    case 'uncommitted':
      return { kind: 'uncommitted' };
    case 'commit':
      return { kind: 'commit', sha: choice.sha };
    case 'session':
      return undefined;
  }
}

/** A key naming a choice, for caches and comment drafts. */
export function scopeKey(choice: ScopeChoice): string {
  switch (choice.kind) {
    case 'branch':
      return `branch:${choice.base ?? ''}`;
    case 'commit':
      return `commit:${choice.sha}`;
    default:
      return choice.kind;
  }
}

/** A commit choice still in `commits` (base..HEAD); otherwise the branch scope (amend, reset). */
export function settleScope(
  choice: ScopeChoice,
  commits: readonly CommitRow[] | undefined,
): ScopeChoice {
  if (choice.kind !== 'commit' || commits === undefined) return choice;
  return commits.some((c) => c.sha === choice.sha) ? choice : DEFAULT_SCOPE;
}

const SCOPES_KEY = 'piarc.git.scopes.v1';
/** Sessions whose scope is remembered. */
const SCOPES_KEPT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function choiceOf(value: unknown): ScopeChoice | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'branch':
      return typeof value.base === 'string'
        ? { kind: 'branch', base: value.base }
        : { kind: 'branch' };
    case 'uncommitted':
    case 'session':
      return { kind: value.kind };
    case 'commit':
      return typeof value.sha === 'string' &&
        typeof value.short === 'string' &&
        typeof value.subject === 'string'
        ? { kind: 'commit', sha: value.sha, short: value.short, subject: value.subject }
        : undefined;
    default:
      return undefined;
  }
}

function readScopes(): [string, ScopeChoice][] {
  try {
    const raw = window.localStorage.getItem(SCOPES_KEY);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
      const choice = choiceOf(entry[1]);
      return choice === undefined ? [] : [[entry[0], choice] as [string, ScopeChoice]];
    });
  } catch {
    return [];
  }
}

/** The scope session `sessionId` showed last. */
export function rememberedScope(sessionId: string): ScopeChoice {
  return readScopes().find(([id]) => id === sessionId)?.[1] ?? DEFAULT_SCOPE;
}

/** Remembers session `sessionId`'s scope (best effort; the newest sessions are kept). */
export function rememberScope(sessionId: string, choice: ScopeChoice): void {
  try {
    const kept = readScopes().filter(([id]) => id !== sessionId);
    kept.unshift([sessionId, choice]);
    window.localStorage.setItem(SCOPES_KEY, JSON.stringify(kept.slice(0, SCOPES_KEPT)));
  } catch {
    // A convenience: without storage the panel starts on the default scope.
  }
}

// ---- Display choices ----

export interface DisplayPrefs {
  readonly layout: 'unified' | 'split';
  readonly wrap: boolean;
  readonly wordDiff: boolean;
  readonly hideWhitespace: boolean;
  readonly showFiles: boolean;
  readonly filesWidth: number;
  readonly tree: boolean;
  readonly groupByKind: boolean;
  readonly commitsOpen: boolean;
}

export const FILES_WIDTH = { min: 160, max: 640, initial: 240, hideBelow: 80 } as const;
/** The body is narrower than this: no file column. */
export const FILES_FIT_WIDTH = 400;
/** The body is narrower than this: side by side falls back to unified. */
export const SPLIT_FIT_WIDTH = 560;

export const DEFAULT_DISPLAY: DisplayPrefs = {
  layout: 'unified',
  wrap: true,
  wordDiff: true,
  hideWhitespace: false,
  showFiles: true,
  filesWidth: FILES_WIDTH.initial,
  tree: true,
  groupByKind: false,
  commitsOpen: true,
};

const DISPLAY_KEY = 'piarc.git.display.v1';

export function clampWidth(width: number): number {
  return Math.round(Math.min(FILES_WIDTH.max, Math.max(FILES_WIDTH.min, width)));
}

export function readDisplay(): DisplayPrefs {
  try {
    const raw = window.localStorage.getItem(DISPLAY_KEY);
    const value: unknown = raw === null ? {} : JSON.parse(raw);
    if (!isRecord(value)) return DEFAULT_DISPLAY;
    const flag = (key: keyof DisplayPrefs) =>
      typeof value[key] === 'boolean' ? value[key] : DEFAULT_DISPLAY[key];
    return {
      layout: value.layout === 'split' ? 'split' : 'unified',
      wrap: flag('wrap') === true,
      wordDiff: flag('wordDiff') === true,
      hideWhitespace: flag('hideWhitespace') === true,
      showFiles: flag('showFiles') === true,
      filesWidth:
        typeof value.filesWidth === 'number' && Number.isFinite(value.filesWidth)
          ? clampWidth(value.filesWidth)
          : FILES_WIDTH.initial,
      tree: flag('tree') === true,
      groupByKind: flag('groupByKind') === true,
      commitsOpen: flag('commitsOpen') === true,
    };
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function saveDisplay(prefs: DisplayPrefs): void {
  try {
    window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(prefs));
  } catch {
    // A convenience only.
  }
}

// ---- Files by kind, as a tree or a flat list ----

export type FileKind = 'source' | 'test' | 'build' | 'generated';

export const KIND_ORDER: readonly FileKind[] = ['source', 'test', 'build', 'generated'];

const GENERATED = [
  /(^|\/)(dist|out|coverage|\.next|\.nuxt|__generated__|generated)\//u,
  /\.min\.(js|css)$/u,
  /\.(map|snap)$/u,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock)$/u,
  /(\.pb\.go|_pb2\.py|\.g\.dart|\.generated\.[a-z]+)$/u,
];

const BUILD = [
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py|setup\.cfg|Gemfile|pom\.xml|Makefile|CMakeLists\.txt|Dockerfile|Justfile)$/u,
  /(^|\/)(tsconfig[^/]*\.json|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|requirements[^/]*\.txt)$/u,
  /(^|\/)(vite|vitest|webpack|rollup|babel|eslint|prettier|tailwind|postcss|jest|playwright)\.config\.[^/]+$/u,
  /(^|\/)(\.eslintrc|\.prettierrc|\.babelrc|\.npmrc|\.nvmrc|\.editorconfig)[^/]*$/u,
  /(^|\/)(\.github\/workflows|\.gitlab|\.circleci)\/[^/]+$/u,
  /(^|\/)docker-compose[^/]*\.ya?ml$/u,
];

const TEST = [
  /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?)\//u,
  /\.(test|spec|e2e)\.[^/]+$/u,
  /_test\.(go|py|rs|rb|exs?)$/u,
  /(^|\/)test_[^/]+\.py$/u,
];

/** The kind of `path`: generated before build before test before source. */
export function kindOf(path: string): FileKind {
  if (GENERATED.some((r) => r.test(path))) return 'generated';
  if (BUILD.some((r) => r.test(path))) return 'build';
  if (TEST.some((r) => r.test(path))) return 'test';
  return 'source';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compares paths segment by segment, numbers by value. */
export function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = collator.compare(x[i] ?? '', y[i] ?? '');
    if (order !== 0) return order;
  }
  return x.length - y.length;
}

export type TreeNode =
  | {
      readonly type: 'dir';
      /** The folders it stands for, joined with `/` when single-child folders were merged. */
      readonly name: string;
      readonly path: string;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly type: 'file';
      readonly name: string;
      readonly path: string;
      readonly file: FileChange;
    };

interface Building {
  dirs: Map<string, Building>;
  files: FileChange[];
}

/** The files as a tree, folders first, single-child folder chains merged into one row. */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const root: Building = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const emit = (node: Building, prefix: string): TreeNode[] => {
    const dirs = [...node.dirs.entries()]
      .sort(([a], [b]) => collator.compare(a, b))
      .map(([name, child]): TreeNode => {
        let label = name;
        let current = child;
        let path = prefix === '' ? name : `${prefix}/${name}`;
        while (current.files.length === 0 && current.dirs.size === 1) {
          const [only] = [...current.dirs.entries()];
          if (only === undefined) break;
          label = `${label}/${only[0]}`;
          path = `${path}/${only[0]}`;
          current = only[1];
        }
        return { type: 'dir', name: label, path, children: emit(current, path) };
      });
    const leaves = [...node.files]
      .sort((a, b) => comparePaths(a.path, b.path))
      .map((file): TreeNode => ({
        type: 'file',
        name: file.path.slice(file.path.lastIndexOf('/') + 1),
        path: file.path,
        file,
      }));
    return [...dirs, ...leaves];
  };
  return emit(root, '');
}

/** A row of the file column. */
export type FileRow =
  | {
      readonly type: 'dir';
      readonly name: string;
      readonly path: string;
      readonly depth: number;
      readonly open: boolean;
    }
  | { readonly type: 'file'; readonly file: FileChange; readonly depth: number };

/** The visible rows of `nodes`, folders in `collapsed` closed. */
export function treeRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): FileRow[] {
  return nodes.flatMap((node): FileRow[] => {
    if (node.type === 'file') return [{ type: 'file', file: node.file, depth }];
    const open = !collapsed.has(node.path);
    const row: FileRow = { type: 'dir', name: node.name, path: node.path, depth, open };
    return open ? [row, ...treeRows(node.children, collapsed, depth + 1)] : [row];
  });
}

/** The files in path order, flat. */
export function flatRows(files: readonly FileChange[]): FileRow[] {
  return [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => ({ type: 'file', file, depth: 0 }));
}

/** The files by kind, in [`KIND_ORDER`]; empty kinds left out. */
export function groupByKind(files: readonly FileChange[]): [FileKind, FileChange[]][] {
  const groups = new Map<FileKind, FileChange[]>();
  for (const file of files) {
    const kind = kindOf(file.path);
    groups.set(kind, [...(groups.get(kind) ?? []), file]);
  }
  return KIND_ORDER.flatMap((kind) => {
    const list = groups.get(kind);
    return list === undefined ? [] : [[kind, list] as [FileKind, FileChange[]]];
  });
}

// ---- Side by side ----

/** One row of the side-by-side view: the old line on the left, the new one on the right. */
export interface SplitRow {
  readonly old?: { readonly line: DiffLine; readonly number: number } | undefined;
  readonly new?: { readonly line: DiffLine; readonly number: number } | undefined;
  /** Index of the paired line in the hunk, for comments and word diffs. */
  readonly oldIndex?: number | undefined;
  readonly newIndex?: number | undefined;
}

/** A hunk's lines side by side: each run of removed lines paired with the added lines after. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.kind === 'context') {
      rows.push({
        old: { line, number: oldNumber++ },
        new: { line, number: newNumber++ },
        oldIndex: i,
        newIndex: i,
      });
      i++;
      continue;
    }
    const removed: number[] = [];
    while (lines[i]?.kind === 'removed') removed.push(i++);
    const added: number[] = [];
    while (lines[i]?.kind === 'added') added.push(i++);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const r = removed[k];
      const a = added[k];
      const oldLine = r === undefined ? undefined : lines[r];
      const newLine = a === undefined ? undefined : lines[a];
      rows.push({
        old: oldLine === undefined ? undefined : { line: oldLine, number: oldNumber++ },
        new: newLine === undefined ? undefined : { line: newLine, number: newNumber++ },
        oldIndex: r,
        newIndex: a,
      });
    }
  }
  return rows;
}

/** For each removed line, the added line it pairs with (and the reverse), by hunk index. */
export function pairedLines(hunk: DiffHunk): Map<number, number> {
  const pairs = new Map<number, number>();
  for (const row of splitRows(hunk)) {
    if (row.oldIndex !== undefined && row.newIndex !== undefined && row.oldIndex !== row.newIndex) {
      pairs.set(row.oldIndex, row.newIndex);
      pairs.set(row.newIndex, row.oldIndex);
    }
  }
  return pairs;
}

// ---- Unchanged lines between hunks ----

/** A run of unchanged lines the diff left out, in new-side numbers, and the old-side offset. */
export interface Gap {
  /** Shown before hunk `before` (`hunks.length`: after the last). */
  readonly before: number;
  /** First and last new-side line of the run. */
  readonly start: number;
  readonly end: number;
  /** Old-side number = new-side number + `delta`. */
  readonly delta: number;
}

function firstNew(h: DiffHunk): number {
  return h.newLines === 0 ? h.newStart + 1 : h.newStart;
}

function nextNew(h: DiffHunk): number {
  return h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines;
}

function firstOld(h: DiffHunk): number {
  return h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
}

function nextOld(h: DiffHunk): number {
  return h.oldLines === 0 ? h.oldStart + 1 : h.oldStart + h.oldLines;
}

/** The runs of unchanged lines around `hunks`; the run after the last needs `total` lines. */
export function gapsOf(hunks: readonly DiffHunk[], total: number | undefined): Gap[] {
  const gaps: Gap[] = [];
  const first = hunks[0];
  if (first === undefined) return gaps;
  if (firstNew(first) > 1) {
    gaps.push({
      before: 0,
      start: 1,
      end: firstNew(first) - 1,
      delta: firstOld(first) - firstNew(first),
    });
  }
  for (let i = 1; i < hunks.length; i++) {
    const prev = hunks[i - 1];
    const next = hunks[i];
    if (prev === undefined || next === undefined) continue;
    const start = nextNew(prev);
    const end = firstNew(next) - 1;
    if (end >= start) gaps.push({ before: i, start, end, delta: nextOld(prev) - nextNew(prev) });
  }
  const last = hunks.at(-1);
  if (last !== undefined && total !== undefined && total >= nextNew(last)) {
    gaps.push({
      before: hunks.length,
      start: nextNew(last),
      end: total,
      delta: nextOld(last) - nextNew(last),
    });
  }
  return gaps;
}

/** Lines revealed per click (above, below or both). */
export const GAP_STEP = 100;

// ---- Changed words ----

/** Lines longer than this are not compared word by word. */
export const WORD_DIFF_MAX_LINE = 1000;
/** Pairs whose token counts multiply past this are not compared. */
const WORD_DIFF_MAX_CELLS = 60_000;

/** Words, runs of spaces and single other characters. */
export function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** Character ranges `[start, end)` of `before` and `after` that are not in their common words. */
export function changedWords(
  before: string,
  after: string,
): { readonly before: [number, number][]; readonly after: [number, number][] } | undefined {
  if (before.length > WORD_DIFF_MAX_LINE || after.length > WORD_DIFF_MAX_LINE) return undefined;
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > WORD_DIFF_MAX_CELLS) return undefined;
  // Longest common subsequence of tokens, by dynamic programming from the end.
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const keepA = new Set<number>();
  const keepB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keepA.add(i++);
      keepB.add(j++);
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  const ranges = (list: string[], keep: Set<number>): [number, number][] => {
    const out: [number, number][] = [];
    let offset = 0;
    list.forEach((token, index) => {
      const end = offset + token.length;
      if (!keep.has(index) && token.trim() !== '') {
        const last = out.at(-1);
        if (last?.[1] === offset) last[1] = end;
        else out.push([offset, end]);
      } else if (!keep.has(index)) {
        const last = out.at(-1);
        if (last?.[1] === offset) last[1] = end;
      }
      offset = end;
    });
    return out.filter(([s, e]) => e > s);
  };
  return { before: ranges(a, keepA), after: ranges(b, keepB) };
}

// ---- Go to file ----

/** Rows the go-to-file list shows at most. */
export const GOTO_LIMIT = 100;
