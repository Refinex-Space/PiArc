// What a row asks of the list it is in: selecting the rows of its exchange, and keeping the
// bottom in view when its content grew.
import { createContext, useContext, useLayoutEffect } from 'react';

export interface ListActions {
  /** Selects every row of the exchange `rowId` belongs to (for copying). */
  readonly selectExchange: (rowId: string) => void;
  /**
   * A row committed new content. Runs in the layout phase, before paint, so the list can pin
   * itself to the bottom in the same frame the row grew (I32): the row's growth shows in the
   * scroll height at once, while the sizer only grows after the virtual list measured the row.
   */
  readonly rowCommitted: () => void;
}

export const ListActionsContext = createContext<ListActions>({
  selectExchange: () => undefined,
  rowCommitted: () => undefined,
});

export function useListActions(): ListActions {
  return useContext(ListActionsContext);
}

/** Tells the list after every commit of the calling component (content that changes on its own:
 * a reply's parsed Markdown, a code block's highlighting). */
export function useRowCommitted(): void {
  const { rowCommitted } = useContext(ListActionsContext);
  useLayoutEffect(() => {
    rowCommitted();
  });
}
