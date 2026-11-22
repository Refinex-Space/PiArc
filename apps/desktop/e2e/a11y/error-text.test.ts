// R5 (accessibility review A14): the error a page shows after an action (its `error` or
// `failure` state) is announced, the way the provider and sandbox pages did it, so a failed
// save, sign-in or install is not silent for screen-reader users. Lists of configuration
// problems stay plain: an alert per item would interrupt the reader for each one.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RENDERER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'renderer',
);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(full);
    return entry.name.endsWith(".tsx") && !entry.name.includes('.test.') ? [full] : [];
  });
}

describe('error texts', () => {
  it('shown after an action are alerts', () => {
    const silent = sources(RENDERER).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /<p[^>]*className="error-text"[^>]*>\{(?:\w+\.)?(?:error|failure)\}/gu,
        ),
      ]
        .filter((m) => !m[0].includes('role="alert"'))
        .map((m) => `${path.relative(RENDERER, file)}: ${m[0]}`),
    );
    expect(silent).toEqual([]);
  });
});
