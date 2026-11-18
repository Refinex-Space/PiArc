import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Item, PermissionMode } from '@piarc/protocol';

import { isObject } from './items.js';

export const MODE_ENTRY = 'piarc.permissionMode';

export function modeRecord(
  entry: SessionEntry,
): { mode: PermissionMode; turnId?: string } | undefined {
  if (entry.type !== 'custom' || entry.customType !== MODE_ENTRY || !isObject(entry.data)) return;
  const { mode, turnId } = entry.data;
  if (mode !== 'default' && mode !== 'acceptEdits') return;
  return typeof turnId === 'string' ? { mode, turnId } : { mode };
}

export function modeItem(itemId: string, mode: PermissionMode): Item {
  return { type: 'permissionModeChanged', itemId, status: 'completed', mode };
}
