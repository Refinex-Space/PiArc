// Writes the design-token outputs (`npm run gen:tokens`): the CSS custom properties for the
// renderer and the TypeScript constants shared by the main process and the renderer, from
// design/tokens/. Outputs are Prettier-formatted, so the drift check can compare bytes.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as prettier from 'prettier';

import {
  OUTPUTS,
  buildModel,
  loadTokenSources,
  renderCss,
  renderTs,
} from '../lib/design-tokens.mjs';
import { isMain, repoRoot } from '../lib/repo.mjs';

/**
 * The generated files and their content.
 * @param {string} [tokensDir]
 * @returns {Promise<{ file: string, content: string }[]>} files relative to the repository root
 */
export async function generateDesignTokens(tokensDir) {
  const model = buildModel(await loadTokenSources(tokensDir));
  const outputs = [
    { file: OUTPUTS.css, content: renderCss(model) },
    { file: OUTPUTS.ts, content: renderTs(model) },
  ];
  return Promise.all(
    outputs.map(async ({ file, content }) => {
      const filepath = path.join(repoRoot, file);
      const config = (await prettier.resolveConfig(filepath)) ?? {};
      return { file, content: await prettier.format(content, { ...config, filepath }) };
    }),
  );
}

async function main() {
  for (const { file, content } of await generateDesignTokens()) {
    const target = path.join(repoRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    console.log(`wrote ${file}`);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
