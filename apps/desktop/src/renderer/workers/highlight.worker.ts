// Code highlighting worker (architecture section 8.4): shiki with TextMate grammars, its
// JavaScript regular-expression engine (the default Oniguruma engine needs WebAssembly, which the
// CSP does not allow), and the token API. Results are colored tokens, never HTML.
import { createHighlighterCore, type HighlighterCore, type LanguageInput } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

import {
  isHighlightRequest,
  type HighlightResponse,
  type HighlightToken,
} from '../transcript/highlight/protocol.js';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

/** One loader per language id of transcript/highlight/languages.ts, so Vite splits them. */
const GRAMMARS: Readonly<Record<string, LanguageInput>> = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  makefile: () => import('@shikijs/langs/makefile'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
};

let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: [],
    // `forgiving` skips the few grammar patterns JavaScript regular expressions cannot express.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

async function loadLanguage(core: HighlighterCore, language: string): Promise<void> {
  const grammar = GRAMMARS[language];
  if (grammar === undefined) {
    throw new Error(`No grammar for ${language}`);
  }
  let pending = loading.get(language);
  if (pending === undefined) {
    pending = core.loadLanguage(grammar);
    loading.set(language, pending);
  }
  await pending;
}

/** Tokens with both themes' styles; neighbours with the same style are merged. */
function tokenize(core: HighlighterCore, code: string, language: string): HighlightToken[][] {
  const lines = core.codeToTokensWithThemes(code, {
    lang: language,
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
  });
  return lines.map((line) => {
    const merged: HighlightToken[] = [];
    for (const token of line) {
      const light = token.variants.light?.color ?? null;
      const dark = token.variants.dark?.color ?? null;
      const fontStyle: number = token.variants.light?.fontStyle ?? 0;
      const last = merged.at(-1);
      if (last?.light === light && last.dark === dark && last.fontStyle === fontStyle) {
        merged[merged.length - 1] = { ...last, text: last.text + token.content };
      } else {
        merged.push({ text: token.content, light, dark, fontStyle });
      }
    }
    return merged;
  });
}

/** Requests are handled one at a time, in order. */
let chain: Promise<void> = Promise.resolve();

function post(message: HighlightResponse): void {
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent) => {
  const request: unknown = event.data;
  if (!isHighlightRequest(request)) {
    console.error('[highlight worker] ignored a malformed request');
    return;
  }
  chain = chain.then(async () => {
    try {
      const core = await getHighlighter();
      await loadLanguage(core, request.language);
      post({
        type: 'highlighted',
        id: request.id,
        lines: tokenize(core, request.code, request.language),
      });
    } catch (error) {
      post({
        type: 'failed',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
