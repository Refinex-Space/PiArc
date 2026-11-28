// Defaults for a custom or local endpoint added from the first-run guide (ADR-0110).

/** Where Ollama and LM Studio listen: the first is the local endpoint's starting address. */
export const LOCAL_BASE_URL = 'http://localhost:11434/v1';

/**
 * A provider id for an endpoint at `baseUrl`: `local` for a local model, otherwise the site's
 * name (`api.example.com` → `example`); a number is added when the id is taken. The id follows
 * the rule of `provider-form.ts` (`[a-z0-9][a-z0-9._-]{0,95}`).
 */
export function endpointId(
  kind: 'custom' | 'local',
  baseUrl: string,
  taken: ReadonlySet<string>,
): string {
  let base = kind === 'local' ? 'local' : 'custom';
  if (kind === 'custom') {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      // An address or `localhost` names no site: keep the generic name.
      const named = !/^[\d.]+$|^\[|^localhost$/u.test(hostname);
      const labels = (named ? hostname : '')
        .split('.')
        .filter((label) => label !== '' && !['api', 'www', 'openai', 'v1'].includes(label));
      const name = labels.length > 1 ? labels[labels.length - 2] : labels[0];
      const clean = (name ?? '').replace(/[^a-z0-9._-]/gu, '-').replace(/^[^a-z0-9]+/u, '');
      if (clean !== '') base = clean.slice(0, 90);
    } catch {
      // Not a URL yet: keep the generic name.
    }
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${String(n)}`;
    if (!taken.has(id)) return id;
  }
}
