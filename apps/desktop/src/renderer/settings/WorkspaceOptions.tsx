// The options of a settings page's workspace picker: each workspace by its folder name, as the
// sidebar names it, with the parent folder when two share a name; the whole path is the option's
// title. The value stays the path, so a long path never stretches or wraps the picker.

/** The last part of a path, Windows or POSIX. */
function lastPart(path: string): string {
  const parts = path.split(/[\\/]+/u).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

/** The folder above `path`'s last part. */
function parentPart(path: string): string {
  const parts = path.split(/[\\/]+/u).filter((part) => part !== '');
  return parts.at(-2) ?? '';
}

/** A short label per workspace: the folder name, made unique with its parent when needed. */
export function workspaceLabels(workspaces: readonly string[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const w of workspaces) counts.set(lastPart(w), (counts.get(lastPart(w)) ?? 0) + 1);
  return new Map(
    workspaces.map((w) => {
      const name = lastPart(w);
      const parent = parentPart(w);
      return [w, (counts.get(name) ?? 0) > 1 && parent !== '' ? `${name} — ${parent}` : name];
    }),
  );
}

export function WorkspaceOptions({ workspaces }: { readonly workspaces: readonly string[] }) {
  const labels = workspaceLabels(workspaces);
  return workspaces.map((w) => (
    <option key={w} value={w} title={w}>
      {labels.get(w) ?? w}
    </option>
  ));
}
