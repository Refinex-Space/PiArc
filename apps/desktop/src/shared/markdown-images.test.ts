import { expect, it } from 'vitest';
import { imageRef, validImageFolder } from './markdown-images.js';
it('accepts document-relative folders and templates on both platforms', () => {
  for (const ok of ['images', './assets', '写作/${filename}.assets'])
    expect(validImageFolder(ok)).toBe(true);
  for (const no of [
    '../private',
    'C:\\data',
    '//share/dir',
    'assets//name',
    'images/CON',
    'a/b?.',
    '/tmp',
  ])
    expect(validImageFolder(no)).toBe(false);
  expect(imageRef('snapshot [a]', './assets/test%20%281%29.png')).toBe(
    '![snapshot \\[a\\]](./assets/test%20%281%29.png)',
  );
});

it('shows the folder template literally in English and Chinese', async () => {
  const { Translator } = await import('./i18n/index.js');
  for (const locale of ['en', 'zh-CN'] as const)
    expect(new Translator(locale).t('files.images.template')).toContain('images/${filename}');
});
