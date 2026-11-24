// A normal HTML table resolves its columns from the actual content and font.
// Only fall back to wrapping a logical row after even the zero-padding matrix
// is wider than its pane. Native cells keep their identities and keyboard order.
let nextTable = 0;
export function repeatTableHeadings(table: HTMLTableElement) {
  const frame = table.parentElement;
  const head = table.tHead?.rows[0];
  if (!frame?.hasAttribute('data-table-bands') || !head) return;
  const id = table.id || (table.id = 'md-responsive-table-' + String(++nextTable));
  const columns = Number(frame.dataset.tableBands);
  const labels = Array.from(head.cells, (cell, col) => {
    cell.scope = 'col';
    cell.id = id + '-col-' + String(col + 1);
    return (cell.querySelector('.md-cell-display') ?? cell).textContent || String(col + 1);
  });
  for (const row of table.rows) {
    for (const cell of row.cells) {
      const col = cell.cellIndex;
      cell.toggleAttribute('data-band-start', col % columns === 0);
      cell.toggleAttribute('data-band-top', row.rowIndex === 0 && col < columns);
      if (row !== head) {
        cell.headers = id + '-col-' + String(col + 1);
        cell.dataset.tableHeading = labels[col] ?? String(col + 1);
      }
    }
  }
}

export function fitFileTable(frame: HTMLElement, table: HTMLTableElement, onResize?: () => void) {
  const win = frame.ownerDocument.defaultView;
  if (!win?.ResizeObserver) return;
  let previousWidth = -1;
  let previousTableWidth = -1;
  let previousFont = '';
  const observer = new win.ResizeObserver(() => {
    const available = frame.clientWidth;
    if (!available) return;
    const font = win.getComputedStyle(table).fontSize;
    if (
      available !== previousWidth ||
      table.offsetWidth !== previousTableWidth ||
      font !== previousFont
    ) {
      previousWidth = available;
      previousFont = font;
      frame.removeAttribute('data-table-bands');
      frame.removeAttribute('data-table-tight');
      if (table.offsetWidth > available) {
        frame.setAttribute('data-table-tight', '');
        if (table.offsetWidth > available) {
          // At this point one full-size glyph per column cannot fit. Show a
          // labelled band of cells at a time, each wide enough for a short word.
          const columns = Math.max(1, Math.floor(available / (6 * parseFloat(font))));
          frame.dataset.tableBands = String(columns);
          frame.style.setProperty('--md-table-band-columns', String(columns));
          repeatTableHeadings(table);
        }
      }
      previousTableWidth = table.offsetWidth;
    }
    onResize?.();
  });
  observer.observe(frame);
  observer.observe(table);
  return () => {
    observer.disconnect();
  };
}
