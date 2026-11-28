import { expect, it } from 'vitest';
import { iconSchemeFromMode, materialIconFile, materialIconUrl } from './material-icons.js';

it('prefers an exact file name over its extension, and the longest extension otherwise', () => {
  expect(materialIconFile('package.json', false, false, 'base')).toBe('nodejs.svg');
  expect(materialIconFile('vite.config.ts', false, false, 'base')).toBe('vite.svg');
  expect(materialIconFile('.gitignore', false, false, 'base')).toBe('git.svg');
  expect(materialIconFile('lib.rs', false, false, 'base')).toBe('rust.svg');
  expect(materialIconFile('types.d.ts', false, false, 'base')).toBe('typescript-def.svg');
  expect(materialIconFile('notes.md', false, false, 'base')).toBe('markdown.svg');
  expect(materialIconFile('README.md', false, false, 'base')).toBe('readme.svg');
  expect(materialIconFile('mystery.zzzap', false, false, 'base')).toBe('file.svg');
  expect(materialIconUrl('package.json', false, false, 'base')).toContain('nodejs');
});

it('uses the open folder glyph and the light-theme override', () => {
  expect(materialIconFile('src', true, false, 'base')).toBe('folder-src.svg');
  expect(materialIconFile('src', true, true, 'base')).toBe('folder-src-open.svg');
  expect(materialIconFile('node_modules', true, true, 'base')).toBe('folder-node-open.svg');
  expect(materialIconFile('not-a-theme-folder', true, false, 'base')).toBe('folder.svg');
  expect(materialIconFile('not-a-theme-folder', true, true, 'base')).toBe('folder-open.svg');
  expect(materialIconFile('Cargo.toml', false, false, 'base')).toBe('toml.svg');
  expect(materialIconFile('Cargo.toml', false, false, 'light')).toBe('toml_light.svg');
  expect(iconSchemeFromMode('lightHighContrast')).toBe('light');
  expect(iconSchemeFromMode('dark')).toBe('base');
});
