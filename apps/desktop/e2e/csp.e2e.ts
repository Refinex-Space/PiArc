// A04: the CSP header blocks injected inline scripts, inline event handlers, eval, and
// requests to external addresses.
import { expect, test } from './fixtures.js';

declare global {
  interface Window {
    __inlineScriptRan?: boolean;
    __inlineHandlerRan?: boolean;
  }
}

test('sends the production CSP as a response header', async ({ page }) => {
  const csp = await page.evaluate(async () => {
    const response = await fetch('/index.html');
    return response.headers.get('content-security-policy');
  });
  expect(csp).not.toBeNull();
  const directives = (csp ?? '').split(';').map((part) => part.trim());
  expect(directives).toEqual(
    expect.arrayContaining([
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
    ]),
  );
  expect(csp).not.toContain('unsafe');
});

test('does not run an injected inline script', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        resolve(event.effectiveDirective);
      });
      // Upper bound so a missing violation fails with a clear value instead of a test timeout.
      setTimeout(() => {
        resolve('no violation');
      }, 5_000);
    });
    const script = document.createElement('script');
    script.textContent = 'window.__inlineScriptRan = true;';
    document.body.append(script);
    return { directive: await violation, ran: window.__inlineScriptRan === true };
  });
  expect(result).toEqual({ directive: 'script-src-elem', ran: false });
});

test('does not run an injected inline event handler', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        resolve(event.effectiveDirective);
      });
      // Upper bound so a missing violation fails with a clear value instead of a test timeout.
      setTimeout(() => {
        resolve('no violation');
      }, 5_000);
    });
    const target = document.createElement('button');
    target.setAttribute('onclick', 'window.__inlineHandlerRan = true;');
    document.body.append(target);
    target.click();
    return { directive: await violation, ran: window.__inlineHandlerRan === true };
  });
  expect(result).toEqual({ directive: 'script-src-attr', ran: false });
});

test('refuses eval and the Function constructor', async ({ page }) => {
  // Run from a timer so the code under test is ordinary page code, not the DevTools
  // evaluation that Playwright uses to inject it.
  const result = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        setTimeout(() => {
          const outcomes: string[] = [];
          try {
            outcomes.push(`eval returned ${String(eval('1 + 1'))}`);
          } catch (error) {
            outcomes.push(error instanceof Error ? error.name : String(error));
          }
          try {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test checks that CSP blocks it.
            const compiled: unknown = new Function('return 2');
            outcomes.push(`Function compiled to a ${typeof compiled}`);
          } catch (error) {
            outcomes.push(error instanceof Error ? error.name : String(error));
          }
          resolve(outcomes);
        }, 0);
      }),
  );
  expect(result).toEqual(['EvalError', 'EvalError']);
});

test('blocks fetch to an external address', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        resolve(`${event.effectiveDirective} ${event.blockedURI}`);
      });
      setTimeout(() => {
        resolve('no violation');
      }, 5_000);
    });
    let outcome: string;
    try {
      const response = await fetch('https://example.com/');
      outcome = `fetched ${String(response.status)}`;
    } catch (error) {
      outcome = error instanceof Error ? error.name : String(error);
    }
    return { outcome, violation: await violation };
  });
  expect(result).toEqual({
    outcome: 'TypeError',
    violation: 'connect-src https://example.com/',
  });
});

test('blocks an external image', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        resolve(`${event.effectiveDirective} ${event.blockedURI}`);
      });
      setTimeout(() => {
        resolve('no violation');
      }, 5_000);
    });
    const image = document.createElement('img');
    const loaded = new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('neither load nor error');
      }, 5_000);
      image.addEventListener('load', () => {
        resolve('load');
      });
      image.addEventListener('error', () => {
        resolve('error');
      });
    });
    image.src = 'https://example.com/pixel.png';
    document.body.append(image);
    return { loaded: await loaded, violation: await violation };
  });
  expect(result).toEqual({
    loaded: 'error',
    violation: 'img-src https://example.com/pixel.png',
  });
});

test('GET, HEAD, a missing asset and an unsupported method retain the app response policy', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const checks = [
      ['/index.html', 'GET'],
      ['/index.html', 'HEAD'],
      ['/missing-piarc-test-asset.js', 'GET'],
      ['/index.html', 'POST'],
    ] as const;
    return Promise.all(
      checks.map(async ([asset, method]) => {
        const response = await fetch(asset, { method, cache: 'no-store' });
        return {
          status: response.status,
          mime: response.headers.get('content-type'),
          csp: response.headers.get('content-security-policy'),
          nosniff: response.headers.get('x-content-type-options'),
          bytes: (await response.arrayBuffer()).byteLength,
        };
      }),
    );
  });
  expect(results.map((r) => r.status)).toEqual([200, 200, 404, 405]);
  expect(results[0]?.mime).toContain('text/html');
  expect(results[1]?.mime).toBe(results[0]?.mime);
  expect(results[0]?.bytes).toBeGreaterThan(0);
  expect(results.slice(1).map((r) => r.bytes)).toEqual([0, 0, 0]);
  for (const response of results) {
    expect(response.csp).toBe(results[0]?.csp);
    expect(response.csp).toContain("script-src 'self'");
    expect(response.nosniff).toBe('nosniff');
  }
});
