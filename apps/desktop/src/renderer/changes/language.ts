// The highlight language of a changed file, from its extension (T28): the names the highlight
// worker knows (transcript/highlight/languages.ts), plus extensions that are not fence names.

import { languageId } from '../transcript/highlight/languages.js';

const EXTENSIONS: Readonly<Record<string, string>> = {
  mjs: 'js',
  cjs: 'js',
  mts: 'ts',
  cts: 'ts',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  hh: 'cpp',
  zsh: 'zsh',
  bash: 'bash',
  json5: 'jsonc',
  htm: 'html',
};

/** The language a diff of `path` is highlighted in, or `null` for plain text. */
export function languageOf(path: string): string | null {
  const name = path.split(/[\\/]/u).pop() ?? path;
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
  if (name.toLowerCase() === 'makefile') return 'makefile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const alias = Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : extension;
  return alias === undefined || languageId(alias) === null ? null : alias;
}
