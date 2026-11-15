// Origin of a URL string as Chromium computes it for the app's pages.
import { APP_SCHEME } from '../app-scheme.js';

/**
 * The serialized origin of `url`, or `'null'` for opaque origins and unparsable input.
 *
 * Node's URL parser does not know the schemes Chromium registered as standard, so it gives
 * `app://piarc/...` an opaque origin. For the app scheme the tuple origin is rebuilt from the
 * scheme and host the way Chromium does; every other scheme keeps Node's answer.
 */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'null';
  }
  if (parsed.origin !== 'null') {
    return parsed.origin;
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host !== '') {
    return `${parsed.protocol}//${parsed.host}`;
  }
  return 'null';
}
