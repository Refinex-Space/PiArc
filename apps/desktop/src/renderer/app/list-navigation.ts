/** Keep a keyboard-selected option visible without scrolling the surrounding window or editor. */
export function revealListOption(option: Element | null): void {
  const list = option?.closest<HTMLElement>('.interactive-list');
  if (!option || !list || list.scrollHeight <= list.clientHeight) return;
  const bounds = option.getBoundingClientRect();
  const top = list.getBoundingClientRect().top + list.clientTop;
  const bottom = top + list.clientHeight;
  if (bounds.top < top) list.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) list.scrollTop += bounds.bottom - bottom;
}
