// verify step "design tokens": the committed outputs match design/tokens/ (drift), every
// declared foreground/background pair meets WCAG in all four color modes of every accent preset,
// the brand rules hold (default accent hue, surfaces, fonts) and no font, sound or other brand's icon is bundled.
// `--tokens <dir>` checks another token directory (for trying a change without editing the
// repository); drift is then skipped.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildModel,
  checkAssets,
  checkBrand,
  checkContrast,
  loadTokenSources,
} from '../lib/design-tokens.mjs';
import { isMain, repoRoot } from '../lib/repo.mjs';
import { generateDesignTokens } from '../dev/gen-design-tokens.mjs';

/**
 * Generated files whose committed content differs from what the tokens produce now.
 * @returns {Promise<string[]>}
 */
export async function driftedOutputs() {
  const drifted = [];
  for (const { file, content } of await generateDesignTokens()) {
    let committed = '';
    try {
      committed = await readFile(path.join(repoRoot, file), 'utf8');
    } catch {
      // A missing file counts as drift.
    }
    if (committed !== content) {
      drifted.push(file);
    }
  }
  return drifted;
}

async function main() {
  const { values } = parseArgs({ options: { tokens: { type: 'string' } } });
  const tokensDir = values.tokens === undefined ? undefined : path.resolve(values.tokens);
  let failed = false;
  const sources = await loadTokenSources(tokensDir);
  const model = buildModel(sources);

  if (tokensDir === undefined) {
    const drifted = await driftedOutputs();
    for (const file of drifted) {
      console.error(`drift: ${file} differs from design/tokens/; run npm run gen:tokens`);
    }
    failed ||= drifted.length > 0;
    console.log(drifted.length === 0 ? 'generated outputs are up to date' : '');
  }

  const results = checkContrast(model, sources.pairs);
  const failing = results.filter((r) => !r.ok);
  for (const r of failing) {
    console.error(
      `contrast: ${r.fg} on ${r.bg} (${r.kind}) in ${r.mode}, accent ${r.accent}, is ` +
        `${r.ratio.toFixed(2)}:1, ` +
        `needs ${r.required.toFixed(1)}:1`,
    );
  }
  const weakest = [...results].sort((a, b) => a.ratio / a.required - b.ratio / b.required)[0];
  console.log(
    `contrast: ${String(results.length - failing.length)}/${String(results.length)} pairs pass ` +
      `(${String(sources.pairs.length)} pairs × 4 modes × ${String(model.accents.ids.length)} accents)` +
      (weakest === undefined
        ? ''
        : `; closest: ${weakest.fg} on ${weakest.bg} in ${weakest.mode} (${weakest.accent}) ` +
          `${weakest.ratio.toFixed(2)}:1 ≥ ${weakest.required.toFixed(1)}:1`),
  );
  failed ||= failing.length > 0;

  const brand = [...checkBrand(model, sources), ...(await checkAssets(repoRoot))];
  for (const problem of brand) {
    console.error(`brand: ${problem}`);
  }
  console.log(
    brand.length === 0
      ? `brand: default accent ramp "${String(model.ramps.accent)}" outside the orange/terracotta hues; ` +
          'system fonts only; no bundled fonts, sounds or other brands’ icons'
      : '',
  );
  failed ||= brand.length > 0;
  if (failed) {
    process.exitCode = 1;
  } else {
    console.log('design token checks passed');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
