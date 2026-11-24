/** Keep a keyboard-selected option visible without scrolling the surrounding window or editor. */
export function revealListOption(option: Element | null): void {
  const list = option?.closest<HTMLElement>('.interactive-list');
  if (!option || !list || list.scrollHeight <= list.clientHeight) return;
  const bounds = option.getBoundingClientRect();
  const origin = list.getBoundingClientRect().top + list.clientTop;
  const style = getComputedStyle(list);
  const top = origin + parseFloat(style.paddingTop);
  const bottom = origin + list.clientHeight - parseFloat(style.paddingBottom);
  // Layout edges may be fractional even when the scroll offset is rounded to a pixel.
  if (bounds.top < top) list.scrollTop += Math.floor(bounds.top - top);
  else if (bounds.bottom > bottom) list.scrollTop += Math.ceil(bounds.bottom - bottom);
}
