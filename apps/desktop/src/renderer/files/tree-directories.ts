import { useCallback, useEffect, useRef, useState } from 'react';
import { isProjectPath } from '../../shared/project-files.js';
import { listProjectFiles } from './api.js';
import { parentPath } from './file-path.js';
import type { FolderPage } from './tree-model.js';
import { reason } from '../shell/errors.js';

export interface TreeReveal {
  readonly path: string;
  readonly nonce: number;
}

function restoredFolders(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return new Set(
      Array.isArray(value)
        ? value.filter((path: unknown): path is string => isProjectPath(path)).slice(0, 128)
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Keep one listing for each visited folder. Rapid disclosure, reveal and refresh can share
 * a read; a late response from the previous generation must never replace newer contents. */
export function useDirectories(sessionId: string, revision: number) {
  const [pages, setPages] = useState<ReadonlyMap<string, FolderPage>>(new Map());
  const storageKey = 'piarc.project-files.expanded.' + sessionId;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => restoredFolders(storageKey));
  const cache = useRef(new Map<string, Promise<FolderPage>>());
  const childHints = useRef(new Map<string, string>());
  const disclosed = useRef(new Set(expanded));
  const revealRequest = useRef(0);
  const sequence = useRef(0);

  const load = useCallback(
    (path: string, includeChild?: string, refresh = false) => {
      if (includeChild) childHints.current.set(path, includeChild);
      const saved = cache.current.get(path);
      if (saved && !refresh && !includeChild) return saved;
      const generation = sequence.current;
      const pending = listProjectFiles(
        sessionId,
        path,
        includeChild ?? childHints.current.get(path),
      )
        .then(
          (page) => page as FolderPage,
          (error: unknown): FolderPage => ({
            entries: [],
            truncated: false,
            error: reason(error),
          }),
        )
        .then((page) => {
          if (generation === sequence.current && cache.current.get(path) === pending) {
            setPages((previous) => new Map(previous).set(path, page));
          }
          return page;
        });
      cache.current.set(path, pending);
      return pending;
    },
    [sessionId],
  );

  const disclosure = useCallback((path: string, open: boolean) => {
    if (open) disclosed.current.add(path);
    else disclosed.current.delete(path);
    setExpanded(new Set(disclosed.current));
  }, []);

  const toggle = useCallback(
    async (path: string) => {
      revealRequest.current++;
      if (disclosed.current.has(path)) {
        disclosure(path, false);
        return;
      }
      const generation = sequence.current;
      let current = path;
      // Follow a chain of single-child folders in one gesture. Stop on collapse or refresh.
      for (let depth = 0; depth < 16; depth++) {
        disclosure(current, true);
        const page = await load(current);
        if (
          sequence.current !== generation ||
          !disclosed.current.has(path) ||
          !disclosed.current.has(current) ||
          page.truncated ||
          page.entries.length !== 1
        )
          break;
        const only = page.entries[0];
        if (only?.kind !== 'directory' || only.link) break;
        current = only.path;
      }
    },
    [load, disclosure],
  );

  const reveal = useCallback(
    async (path: string) => {
      const generation = sequence.current;
      const ticket = ++revealRequest.current;
      const parts = path.split('/');
      let directory = '';
      for (const [index, part] of parts.entries()) {
        // Reload capped pages with an explicit child hint only if the first page omitted it.
        let page = await load(directory);
        if (sequence.current !== generation || ticket !== revealRequest.current) return;
        if (page.truncated && !page.entries.some((entry) => entry.name === part))
          page = await load(directory, part);
        if (sequence.current !== generation || ticket !== revealRequest.current) return;
        const child = page.entries.find((entry) => entry.name === part);
        if (!child || (child.link && child.link.state !== 'ok') || index === parts.length - 1)
          return;
        if (child.kind !== 'directory') return;
        disclosure(child.path, true);
        directory = child.path;
      }
    },
    [load, disclosure],
  );

  useEffect(() => {
    cache.current.clear();
    void load('');
    return () => {
      sequence.current++;
    };
  }, [sessionId, revision, load]);
  useEffect(() => {
    // A restored name must be present in a listing from this session before a browse
    // request enters it. Closed ancestors are not walked.
    for (const path of expanded) {
      if (cache.current.has(path)) continue;
      let parent = parentPath(path);
      const known = pages.get(parent)?.entries.find((child) => child.path === path);
      if (known?.kind !== 'directory' || (known.link && known.link.state !== 'ok')) continue;
      while (parent && expanded.has(parent)) parent = parentPath(parent);
      if (!parent) void load(path);
    }
  }, [expanded, load, pages, revision]);
  useEffect(() => {
    try {
      if (expanded.size)
        sessionStorage.setItem(storageKey, JSON.stringify([...expanded].slice(0, 128)));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // A full or unavailable storage area still permits expanding folders in this panel.
    }
  }, [expanded, storageKey]);
  return {
    pages,
    expanded,
    toggle,
    reveal,
    retry: (folder: string) => void load(folder, undefined, true),
  };
}
