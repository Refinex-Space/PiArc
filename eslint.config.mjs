// ESLint flat config: type-aware typescript-eslint rules for every TS and JS
// file, with formatting left entirely to Prettier.
import { builtinModules } from 'node:module';

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
  prettier,
);

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
  return [
    {
      files: ['apps/desktop/src/**/*.{ts,tsx}'],
      ignores: ['apps/desktop/src/main/window.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          ...['Identifier', 'MemberExpression'].map((callee) => ({
            selector: `NewExpression[callee.type='${callee}'][callee.${callee === 'Identifier' ? 'name' : 'property.name'}='BrowserWindow']`,
            message: 'Create windows with createMainWindow() in src/main/window.ts.',
          })),
        ],
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
