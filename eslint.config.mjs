// ESLint flat config: type-aware typescript-eslint rules for every TS and JS
// file, with formatting left entirely to Prettier.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/out/',
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
  prettier,
);
