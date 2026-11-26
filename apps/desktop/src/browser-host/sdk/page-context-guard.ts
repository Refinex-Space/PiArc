// Ported from ego-browser package/ego-browser/src/page-context-guard.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: the script runs in PiArc's script host, a page with its own document
// and window, so instead of guard getters on globalThis (which cannot replace the host's own
// globals) run.ts passes these names to the script as parameters that throw the hint when used.

const PAGE_ONLY_GLOBALS = [
  'document',
  'innerHeight',
  'innerWidth',
  'localStorage',
  'location',
  'scrollX',
  'scrollY',
  'sessionStorage',
  'window',
] as const;
const PAGE_ONLY_GLOBAL_NAMES = new Set<string>(PAGE_ONLY_GLOBALS);

function pageContextHint(globalName: string): string {
  return (
    `The browser script runs in PiArc's script host, not in the Page. ${globalName} is a Page global. ` +
    'Put browser-side code inside page.evaluate(), for example page.evaluate(() => ...); ' +
    'keep the rest of the script outside it.'
  );
}

/** Add one actionable hint to the common script-versus-Page context mistake. */
export function addPageContextHint(error: unknown): unknown {
  if (!(error instanceof ReferenceError)) return error;
  const match = /^([A-Za-z_$][\w$]*) is not defined\.?$/i.exec(error.message.trim());
  const globalName = match?.[1];
  if (globalName === undefined || !PAGE_ONLY_GLOBAL_NAMES.has(globalName)) return error;
  if (error.message.includes('page.evaluate()')) return error;

  const originalMessage = error.message;
  error.message = `${originalMessage}. ${pageContextHint(globalName)}`;
  if (typeof error.stack === 'string') {
    const lines = error.stack.split('\n');
    lines[0] = `${error.name}: ${error.message}`;
    error.stack = lines.join('\n');
  }
  return error;
}

/**
 * One stand-in per Page-only global, passed to the script under the global's
 * name. Any use other than `typeof` or a truthiness test throws a ReferenceError
 * carrying the hint, so `document.title` in the script fails the same way it
 * fails in upstream's Node context instead of reading the host page.
 */
export function pageContextShadows(): Record<string, unknown> {
  const shadows: Record<string, unknown> = {};
  for (const globalName of PAGE_ONLY_GLOBALS) {
    const fail = (): never => {
      throw new ReferenceError(`${globalName} is not defined. ${pageContextHint(globalName)}`);
    };
    shadows[globalName] = new Proxy(
      {},
      {
        get: fail,
        set: fail,
        has: fail,
        deleteProperty: fail,
        ownKeys: fail,
        getOwnPropertyDescriptor: fail,
        defineProperty: fail,
        getPrototypeOf: fail,
        setPrototypeOf: fail,
      },
    );
  }
  return shadows;
}
