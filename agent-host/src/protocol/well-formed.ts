// Strings sent to Core must be valid Unicode: Core's frames are UTF-8, and an unpaired
// surrogate (a model output cut inside an emoji) makes `encodeFrame` throw. Replacing them
// with U+FFFD is what Rust's lossy conversion would do on the other side.

/** `value` with every unpaired surrogate in its keys and strings replaced by U+FFFD. */
export function wellFormedJson(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key.toWellFormed(), wellFormedValue(member)]),
  );
}

/** Like `wellFormedJson`, for any JSON value. */
export function wellFormedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toWellFormed();
  }
  if (Array.isArray(value)) {
    return value.map(wellFormedValue);
  }
  return isRecord(value) ? wellFormedJson(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
