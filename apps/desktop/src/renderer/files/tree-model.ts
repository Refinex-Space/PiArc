// The same flat projection drives keyboard navigation, selection, drag payloads and the
// virtual viewport. Directory paths here always use Core's workspace-relative notation.
import type { ProjectEntry, ProjectMatch } from './api.js';

export interface FolderPage {
  readonly entries: readonly ProjectEntry[];
  readonly truncated: boolean;
  readonly error?: string;
}

export interface TreeRow {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly directory: boolean;
  readonly blocked?: boolean;
  readonly link?: ProjectEntry['link'];
  readonly note?: 'empty' | 'loading' | 'truncated' | 'error' | 'more';
  readonly remaining?: number;
  readonly detail?: string;
  readonly match?: ProjectMatch;
}

export function treeRows(
  pages: ReadonlyMap<string, FolderPage>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  function visit(folder: string, depth: number): void {
    const page = pages.get(folder);
    const note =
      page?.error !== undefined
        ? 'error'
        : !page
          ? 'loading'
          : page.truncated
            ? 'truncated'
            : !page.entries.length
              ? 'empty'
              : undefined;
    for (const entry of page?.entries ?? []) {
      const directory = entry.kind === 'directory';
      const blocked =
        entry.kind === 'other' || (entry.link !== undefined && entry.link.state !== 'ok');
      rows.push({
        id: entry.path,
        path: entry.path,
        name: entry.name,
        directory,
        depth,
        blocked,
        link: entry.link,
      });
      if (directory && !blocked && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
    if (note)
      rows.push({
        id: '\u0000' + folder,
        path: folder,
        name: '',
        depth,
        directory: false,
        note,
        ...(page?.error !== undefined ? { detail: page.error } : {}),
      });
  }
  visit('', 1);
  return rows;
}

export function searchRows(
  matches: readonly ProjectMatch[],
  content: boolean,
  fullGroups?: ReadonlySet<string>,
): TreeRow[] {
  if (!content)
    return matches.map((match) => ({
      id: match.path,
      path: match.path,
      name: match.name,
      directory: match.kind === 'directory',
      depth: 1,
      match,
    }));
  const groups = new Map<string, ProjectMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.path);
    if (group) group.push(match);
    else groups.set(match.path, [match]);
  }
  const rows: TreeRow[] = [];
  for (const [path, group] of groups) {
    const first = group[0];
    if (!first) continue;
    rows.push({ id: path, path, name: first.name, depth: 1, directory: false });
    const shown = fullGroups?.has(path) ? group : group.slice(0, 5);
    for (const [i, match] of shown.entries()) {
      rows.push({
        id: path + '\u0000' + String(i),
        path,
        name: match.name,
        depth: 2,
        directory: false,
        match,
      });
    }
    if (shown.length < group.length)
      rows.push({
        id: path + '\u0000more',
        path,
        name: first.name,
        directory: false,
        depth: 2,
        note: 'more',
        remaining: group.length - shown.length,
      });
  }
  return rows;
}

export interface TreeSelection {
  readonly anchor: string;
  readonly paths: ReadonlySet<string>;
}

export function selectRow(
  previous: TreeSelection,
  rows: readonly TreeRow[],
  target: TreeRow,
  mode: 'single' | 'toggle' | 'range',
): TreeSelection {
  if (mode === 'range') {
    const anchor = rows.findIndex((row) => row.id === previous.anchor);
    const end = rows.indexOf(target);
    if (anchor >= 0 && end >= 0) {
      const range = rows.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
      return {
        anchor: previous.anchor,
        paths: new Set(range.filter((row) => !row.note).map((row) => row.path)),
      };
    }
  }
  if (mode === 'toggle') {
    const paths = new Set(previous.paths);
    if (!paths.delete(target.path)) paths.add(target.path);
    return { anchor: target.id, paths };
  }
  return { anchor: target.id, paths: new Set([target.path]) };
}
