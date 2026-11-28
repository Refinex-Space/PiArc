// The proxy Core hands the Agent Host (ADR-0082): `HTTP(S)_PROXY`, `NO_PROXY` and
// `NODE_USE_ENV_PROXY=1`, with which Node installs a proxy-aware dispatcher for its built-in
// `fetch` before any module runs. Loading Pi undoes that on some Node versions: the npm undici
// Pi depends on sets its own global dispatcher when it loads, a plain `Agent` that it also writes
// over the slot Node's `fetch` reads, so every request (model calls, sign-in) went direct and a
// provider behind a regional block answered "fetch failed".
//
// This module must load before Pi: the entry imports it statically and Pi only dynamically
// (main.ts), so the dispatcher seen here is Node's. `restoreEnvProxy` puts it back once Pi is
// loaded. Keep this file free of imports: anything loading undici first would defeat it.

/** The slot Node's built-in `fetch` reads its dispatcher from (shared by every undici copy). */
const FETCH_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

const nodeDispatcher: unknown = Reflect.get(globalThis, FETCH_DISPATCHER);

/** Whether Node was started to honour the proxy variables, and one is set. */
function proxyRequested(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_USE_ENV_PROXY !== '1') return false;
  return [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].some(
    (value) => value !== undefined && value !== '',
  );
}

/**
 * Gives Node's `fetch` back the proxy-aware dispatcher Node installed at start when something
 * replaced it since. Answers whether it did.
 */
export function restoreEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!proxyRequested(env) || nodeDispatcher === undefined) return false;
  if (Reflect.get(globalThis, FETCH_DISPATCHER) === nodeDispatcher) return false;
  return Reflect.set(globalThis, FETCH_DISPATCHER, nodeDispatcher);
}
