// Native radio inputs own selection and keyboard navigation. The one decorative thumb follows
// the actual label bounds, including after translations, density changes and font loading.
import { useId, useLayoutEffect, useRef, type AriaAttributes } from 'react';

interface Props<T extends string> extends Pick<AriaAttributes, 'aria-label' | 'aria-labelledby'> {
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly labelOf: (value: T) => string;
  readonly hintOf?: (value: T) => string;
  readonly name?: string;
  readonly testIdPrefix?: string;
  readonly testId?: string;
  readonly className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labelOf,
  hintOf,
  name,
  testIdPrefix,
  testId,
  className,
  ...accessibleName
}: Props<T>) {
  const groupId = useId();
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const previous = useRef<T | null>(null);

  useLayoutEffect(() => {
    const group = track.current;
    const surface = thumb.current;
    if (!group || !surface) return;
    const selected = group.querySelector('input:checked')?.parentElement;
    surface.hidden = !selected;
    if (!selected) {
      previous.current = null;
      return;
    }
    let lastBounds: { left: number; width: number } | undefined;
    const place = (animate: boolean) => {
      const bounds = selected.getBoundingClientRect();
      const left = bounds.left - group.getBoundingClientRect().left;
      // ResizeObserver also fires on subscription. Keep the running selection transition
      // when that notification reports the same (possibly fractional) target.
      if (lastBounds?.left === left && lastBounds.width === bounds.width) return;
      lastBounds = { left, width: bounds.width };
      surface.toggleAttribute('data-moving', animate);
      surface.style.width = String(bounds.width) + 'px';
      surface.style.transform = 'translateX(' + String(left) + 'px)';
    };
    place(previous.current !== null && previous.current !== value);
    previous.current = value;
    const observer = new ResizeObserver(() => {
      place(false);
    });
    for (const label of group.querySelectorAll('label')) observer.observe(label);
    return () => {
      observer.disconnect();
    };
  }, [options, value]);

  return (
    <div
      ref={track}
      className={className ? 'segmented ' + className : 'segmented'}
      role="radiogroup"
      {...accessibleName}
      data-testid={testId}
    >
      <span ref={thumb} className="segment-thumb" aria-hidden="true" />
      {options.map((option) => (
        <label key={option} className="segment" title={hintOf?.(option)}>
          <input
            type="radio"
            name={name ?? groupId}
            value={option}
            checked={value === option}
            data-testid={testIdPrefix && testIdPrefix + '-' + option}
            onChange={() => {
              onChange(option);
            }}
          />
          {labelOf(option)}
        </label>
      ))}
    </div>
  );
}
