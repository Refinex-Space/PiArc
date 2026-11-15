// ESLint flat config: type-aware typescript-eslint rules for every TS and JS
// file, with formatting left entirely to Prettier.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/out/',
    '**/.vite/',
    '**/coverage/',
    'target/',
    'tmp/',
    '.tools/',
    'reference/',
    'docs/',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      parserOptions: {
        // Each file is checked with the tsconfig that owns it; root-level config
        // files belong to scripts/tsconfig.json.
        projectService: true,
        jsDocParsingMode: 'all',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript (strict, checkJs) already reports undefined identifiers.
      'no-undef': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    // Generated from the protocol schema (`npm run gen:protocol`). Only the two stylistic
    // rules about the shape json-schema-to-typescript emits are off; every correctness
    // rule still applies.
    files: ['packages/protocol/src/generated/**'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
    },
  },
  ...desktopProcessBoundaries(),
  agentHostIoBoundary(),
  piPublicImports(),
  prettier,
);

/**
 * The Agent Host's tool layer and Harness Kit delegate all file and process I/O to Core
 * (ADR-0004, architecture section 6.1.3): `agent-host/src/tools/` and `agent-host/src/harness/`
 * may not import `fs` or `child_process`, statically or dynamically.
 * @returns {import('eslint').Linter.Config}
 */
function agentHostIoBoundary() {
  const message =
    'Tools and the Harness Kit delegate file and process I/O to Core (ADR-0004): use CoreIo.';
  const modules = ['fs', 'fs/promises', 'child_process'];
  const names = modules.flatMap((name) => [name, `node:${name}`]);
  return {
    files: ['agent-host/src/tools/**/*.ts', 'agent-host/src/harness/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: names.map((name) => ({ name, message })) }],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression[source.value=/^(node:)?(fs|fs\\/promises|child_process)$/]`,
          message,
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(fs|fs\\/promises|child_process)$/]`,
          message,
        },
      ],
    },
  };
}

/**
 * Pi packages may only be imported through their public entry points (architecture section
 * 5.7): the package itself and the subpaths its package.json `exports` declares, such as
 * `@earendil-works/pi-ai/api/anthropic-messages.lazy`. Any other path into a package
 * (`dist/...`, internal modules) is a deep import and fails lint. The allowed subpaths are
 * read from the installed packages, so they follow the locked Pi version.
 * @returns {import('eslint').Linter.Config}
 */
function piPublicImports() {
  const scope = '@earendil-works';
  const scopeDir = path.join(import.meta.dirname, 'node_modules', scope);
  const packages = existsSync(scopeDir) ? readdirSync(scopeDir) : [];
  const allowed = packages.flatMap((name) => {
    const manifest = path.join(scopeDir, name, 'package.json');
    if (!existsSync(manifest)) {
      return [];
    }
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    const exportsField =
      typeof parsed === 'object' && parsed !== null && 'exports' in parsed
        ? parsed.exports
        : undefined;
    const subpaths =
      typeof exportsField === 'object' && exportsField !== null
        ? Object.keys(exportsField).filter((key) => key.startsWith('./'))
        : [];
    // Node's subpath patterns: `*` matches any non-empty string, slashes included.
    return subpaths.map(
      (subpath) =>
        `${escapeRegExp(name)}/${subpath.slice(2).split('*').map(escapeRegExp).join('.+')}`,
    );
  });
  const exempt = allowed.length > 0 ? `(?!(?:${allowed.join('|')})$)` : '';
  return {
    files: ['**/*.{ts,tsx,mts,js,mjs}'],
    rules: {
      // The typescript-eslint variant also covers `import type`, and it does not collide with
      // the `no-restricted-imports` settings of the desktop process boundaries.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^${escapeRegExp(scope)}/${exempt}[^/]+/.+$`,
              message:
                'Import Pi packages only through their entry or a subpath their package.json exports (architecture section 5.7).',
            },
          ],
        },
      ],
    },
  };
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Process-boundary rules of the desktop app (ADR-0013, architecture section 10.3): one window
 * factory, one IPC registration function, no Node built-ins in the sandboxed preload and none
 * of Node or Electron in the renderer.
 * @returns {import('eslint').Linter.Config[]}
 */
function desktopProcessBoundaries() {
  const nodeBuiltins = builtinModules.flatMap((name) =>
    name.startsWith('node:') ? [name] : [name, `node:${name}`],
  );
  /** @param {string} message */
  const builtinPaths = (message) => nodeBuiltins.map((name) => ({ name, message }));
  const browserWindow = ['Identifier', 'MemberExpression'].map((callee) => ({
    selector: `NewExpression[callee.type='${callee}'][callee.${callee === 'Identifier' ? 'name' : 'property.name'}='BrowserWindow']`,
    message: 'Create windows with createMainWindow() in src/main/window.ts.',
  }));
  // Model output and repository content are untrusted (architecture section 10.3): the renderer
  // builds DOM through React elements only, never from HTML strings.
  const htmlSinkMessage =
    'The renderer never parses HTML strings: render React elements (see transcript/markdown/MarkdownView.tsx).';
  const htmlSinks = [
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message: htmlSinkMessage,
    },
    {
      selector: "Property[key.name='dangerouslySetInnerHTML']",
      message: htmlSinkMessage,
    },
    ...['innerHTML', 'outerHTML'].map((property) => ({
      selector: `MemberExpression[property.name='${property}']`,
      message: htmlSinkMessage,
    })),
    ...['insertAdjacentHTML', 'createContextualFragment', 'setHTMLUnsafe', 'parseHTMLUnsafe'].map(
      (method) => ({
        selector: `CallExpression[callee.property.name='${method}']`,
        message: htmlSinkMessage,
      }),
    ),
    {
      selector: "CallExpression[callee.object.name='document'][callee.property.name=/^writeln?$/]",
      message: htmlSinkMessage,
    },
  ];
  return [
    {
      files: ['apps/desktop/src/**/*.{ts,tsx}'],
      ignores: ['apps/desktop/src/main/window.ts', 'apps/desktop/src/renderer/**'],
      rules: {
        'no-restricted-syntax': ['error', ...browserWindow],
      },
    },
    {
      files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': ['error', ...browserWindow, ...htmlSinks],
      },
    },
    {
      files: ['apps/desktop/src/main/**/*.ts'],
      ignores: ['apps/desktop/src/main/ipc/register.ts'],
      rules: {
        'no-restricted-properties': [
          'error',
          ...['handle', 'handleOnce', 'on', 'once', 'addListener'].map((property) => ({
            object: 'ipcMain',
            property,
            message: 'Register IPC handlers with registerHandler (src/main/ipc/register.ts).',
          })),
        ],
      },
    },
    {
      files: ['apps/desktop/src/preload/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: builtinPaths('The sandboxed preload can only require electron.'),
          },
        ],
      },
    },
    {
      files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...builtinPaths('The renderer has no Node.js; use window.piarc.'),
              { name: 'electron', message: 'The renderer has no Electron; use window.piarc.' },
            ],
            patterns: [
              {
                group: ['**/main/**', '**/preload/**'],
                message: 'The renderer may only import src/shared from other processes.',
              },
            ],
          },
        ],
      },
    },
  ];
}
