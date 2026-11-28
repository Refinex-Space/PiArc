import { isProjectPath, projectRecord } from '../../shared/project-files.js';
export interface FileTabs {
  paths: string[];
  active: string | null;
  preview: string | null;
}
const empty: FileTabs = { paths: [], active: null, preview: null };
export function restoreTabs(id: string): FileTabs {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem('piarc.files.tabs.' + id) ?? 'null');
    if (!projectRecord(value) || !Array.isArray(value.paths)) return empty;
    const paths = [...new Set(value.paths.filter((p: unknown): p is string => isProjectPath(p)))];
    const match = (p: unknown) => (typeof p === 'string' && paths.includes(p) ? p : null);
    return {
      paths,
      active: match(value.active) ?? paths[0] ?? null,
      preview: match(value.preview),
    };
  } catch {
    return empty;
  }
}
export function selectFile(tabs: FileTabs, path: string, pin: boolean): FileTabs {
  if (tabs.paths.includes(path))
    return { ...tabs, active: path, preview: pin && tabs.preview === path ? null : tabs.preview };
  const paths =
    !pin && tabs.preview
      ? tabs.paths.map((old) => (old === tabs.preview ? path : old))
      : [...tabs.paths, path];
  return { paths, active: path, preview: pin ? tabs.preview : path };
}
export function closeFiles(tabs: FileTabs, closed: readonly string[]): FileTabs {
  const paths = tabs.paths.filter((p) => !closed.includes(p));
  const index = tabs.active ? tabs.paths.indexOf(tabs.active) : 0;
  return {
    paths,
    active:
      tabs.active && paths.includes(tabs.active)
        ? tabs.active
        : (paths[Math.min(index, paths.length - 1)] ?? null),
    preview: tabs.preview && paths.includes(tabs.preview) ? tabs.preview : null,
  };
}
