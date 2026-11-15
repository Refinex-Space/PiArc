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
    });
    const image = document.createElement('img');
    const loaded = new Promise<string>((resolve) => {
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
