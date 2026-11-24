// Rail preferences contain stable section ids only. Hidden sections keep their slots while the
// user reorders the available ones, so a later task or plan has its original place.
import { localStore } from './layout.js';

interface RailPreferences {
  readonly order: readonly string[];
  readonly expanded: Readonly<Record<string, boolean>>;
}

const KEY = 'piarc.rail.sections.v1';

export function readRailPreferences(): RailPreferences {
  try {
    const data: unknown = JSON.parse(localStore()?.getItem(KEY) ?? 'null');
    if (typeof data === 'object' && data !== null) {
      const order: unknown = 'order' in data ? data.order : undefined;
      const expanded: unknown = 'expanded' in data ? data.expanded : undefined;
      return {
        order: Array.isArray(order)
          ? [...new Set(order.filter((id): id is string => typeof id === 'string'))]
          : [],
        expanded:
          expanded && typeof expanded === 'object' && !Array.isArray(expanded)
            ? Object.fromEntries(
                Object.entries(expanded).filter(
                  (pair): pair is [string, boolean] => typeof pair[1] === 'boolean',
                ),
              )
            : {},
      };
    }
  } catch {
    // An unavailable or malformed preference leaves all registered sections usable.
  }
  return { order: [], expanded: {} };
}

export function saveRailPreferences(value: RailPreferences): void {
  try {
    localStore()?.setItem(KEY, JSON.stringify(value));
  } catch {
    // The current window keeps its layout if storage is blocked or full.
  }
}

export function railOrder(registered: readonly string[], saved: readonly string[]): string[] {
  return [
    ...saved.filter((id) => registered.includes(id)),
    ...registered.filter((id) => !saved.includes(id)),
  ];
}

export function moveRailSection(
  order: readonly string[],
  visible: readonly string[],
  from: string,
  to: string,
): readonly string[] {
  const oldIndex = visible.indexOf(from);
  const newIndex = visible.indexOf(to);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return order;
  const moved = [...visible];
  moved.splice(oldIndex, 1);
  moved.splice(newIndex, 0, from);
  let next = 0;
  return order.map((id) => (visible.includes(id) ? (moved[next++] ?? id) : id));
}
