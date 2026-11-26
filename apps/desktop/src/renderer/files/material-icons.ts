declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: {
        readonly eager: true;
        readonly query: '?url&no-inline';
        readonly import: 'default';
      },
    ): Record<string, string>;
  }
}

// File-tree glyphs from Material Icon Theme (MIT). The shipped manifest is the same
// association table VS Code uses: an exact file or folder name wins, otherwise the
// longest extension, otherwise the default file or folder icon.
import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };

export type IconScheme = 'base' | 'light';

interface IconDefinition {
  readonly iconPath?: string;
}

interface IconTables {
  readonly fileNames?: Readonly<Record<string, string>>;
  readonly fileExtensions?: Readonly<Record<string, string>>;
  readonly folderNames?: Readonly<Record<string, string>>;
  readonly folderNamesExpanded?: Readonly<Record<string, string>>;
}

interface IconTheme extends IconTables {
  readonly file: string;
  readonly folder: string;
  readonly folderExpanded: string;
  readonly iconDefinitions: Readonly<Record<string, IconDefinition>>;
  readonly light?: IconTables;
}

const theme = manifest as IconTheme;

/** `light` and `lightHighContrast` use the theme's light overrides (for example toml). */
export function iconSchemeFromMode(mode: string | undefined): IconScheme {
  return mode === 'light' || mode === 'lightHighContrast' ? 'light' : 'base';
}

function named(
  base: Readonly<Record<string, string>> | undefined,
  light: Readonly<Record<string, string>> | undefined,
  key: string,
  scheme: IconScheme,
): string | undefined {
  if (scheme === 'light') {
    const override = light?.[key];
    if (override) return override;
  }
  return base?.[key];
}

function fileIconId(name: string, scheme: IconScheme): string {
  const lower = name.toLowerCase();
  const exact = named(theme.fileNames, theme.light?.fileNames, lower, scheme);
  if (exact) return exact;
  const parts = lower.split('.');
  let match: { readonly length: number; readonly id: string } | undefined;
  for (let index = 1; index < parts.length; index += 1) {
    const extension = parts.slice(index).join('.');
    const id = named(theme.fileExtensions, theme.light?.fileExtensions, extension, scheme);
    if (id && (match === undefined || extension.length > match.length)) {
      match = { length: extension.length, id };
    }
  }
  return match?.id ?? theme.file;
}

function folderIconId(name: string, open: boolean, scheme: IconScheme): string {
  const key = name.toLowerCase();
  if (open) {
    return (
      named(theme.folderNamesExpanded, theme.light?.folderNamesExpanded, key, scheme) ??
      named(theme.folderNames, theme.light?.folderNames, key, scheme) ??
      theme.folderExpanded
    );
  }
  return named(theme.folderNames, theme.light?.folderNames, key, scheme) ?? theme.folder;
}

/** SVG file name inside the theme package, such as `typescript.svg`. */
export function materialIconFile(
  name: string,
  directory: boolean,
  open: boolean,
  scheme: IconScheme,
): string {
  const id = directory ? folderIconId(name, open, scheme) : fileIconId(name, scheme);
  const iconPath = theme.iconDefinitions[id]?.iconPath;
  if (!iconPath) return directory ? (open ? 'folder-open.svg' : 'folder.svg') : 'file.svg';
  const slash = iconPath.lastIndexOf('/');
  return slash === -1 ? iconPath : iconPath.slice(slash + 1);
}

const iconUrls = import.meta.glob('../../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
});

const urlByFile = new Map<string, string>();
for (const [file, url] of Object.entries(iconUrls)) {
  const slash = file.lastIndexOf('/');
  urlByFile.set(slash === -1 ? file : file.slice(slash + 1), url);
}

/** Bundled URL for the icon, or undefined when the SVG was not packaged. */
export function materialIconUrl(
  name: string,
  directory: boolean,
  open: boolean,
  scheme: IconScheme,
): string | undefined {
  return urlByFile.get(materialIconFile(name, directory, open, scheme));
}
