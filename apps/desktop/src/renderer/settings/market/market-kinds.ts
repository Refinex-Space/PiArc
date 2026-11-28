// How a market entry presents its kinds (ADR-0102): the tile of its first kind and the kinds in
// words. Themes are not a category PiArc uses, so they are not named.
import type { MarketEntry } from '@piarc/protocol';

import type { MessageId } from '../../../shared/i18n/index.js';
import type { CatalogKind } from '../catalog.js';

/** The tile of an entry: its first kind (extensions before skills before prompts). */
export function entryTile(entry: MarketEntry): CatalogKind {
  if (entry.kinds.includes('extension')) return 'extension';
  if (entry.kinds.includes('skill')) return 'skill';
  if (entry.kinds.includes('prompt')) return 'prompt';
  return 'package';
}

/** The kinds an entry brings, in words ("Extension · Skill"). */
export function kindsText(t: (id: MessageId) => string, entry: MarketEntry): string {
  return (['extension', 'skill', 'prompt'] as const)
    .filter((k) => entry.kinds.includes(k))
    .map((k) => t(`market.kind.${k}`))
    .join(' · ');
}
