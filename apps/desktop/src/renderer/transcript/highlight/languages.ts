// Languages the highlight worker can load, keyed by shiki's language id, and the names a fence's
// info string may use for them. Grammars load on first use (one chunk each). Languages that
// embed many others (Markdown, MDX, Vue, PHP) are left out to keep that cost small; their code
// stays plain text.

/** Names accepted in an info string → shiki language id. */
const ALIASES: Readonly<Record<string, string>> = {
  bash: 'shellscript',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  css: 'css',
  diff: 'diff',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  go: 'go',
  golang: 'go',
  graphql: 'graphql',
  html: 'html',
  ini: 'ini',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kotlin: 'kotlin',
  kt: 'kotlin',
  lua: 'lua',
  makefile: 'makefile',
  patch: 'diff',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  rs: 'rust',
  rust: 'rust',
  scss: 'scss',
  sh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript',
};

/** The shiki language id for an info-string language, or `null` when it is not supported. */
export function languageId(lang: string | null): string | null {
  if (lang === null) {
    return null;
  }
  const id = ALIASES[lang.toLowerCase()];
  return id ?? null;
}

/** Code longer than this stays plain text: highlighting it would cost more than it helps. */
export const HIGHLIGHT_MAX_CHARS = 100_000;
