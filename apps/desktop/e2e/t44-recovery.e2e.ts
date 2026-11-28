// T44: a renderer that crashes comes back. The main process reloads a window whose renderer
// went away abnormally, so the app shell and the session list show again; the session the
// window showed can be opened and its transcript is there.
import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

test('a crashed renderer is reloaded and its session can be opened again', async ({
  app,
  page,
  workspaces,
}) => {
  const { id } = await openSession(app, page, workspaces, 'crash 崩溃', 't18-chat', 'Hello');
  await idle(page);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
  });
  // Ask the main process: the window's renderer is back and shows the app shell.
  await expect
    .poll(
      () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (contents === undefined || contents.isCrashed() || contents.isLoading()) return false;
          try {
            return (await contents.executeJavaScript(
              'document.querySelector(\'[data-testid="app-shell"]\') !== null',
            )) as boolean;
          } catch {
            // The reload can dispose the frame between the checks above and this call
            // ("Render frame was disposed", Windows CI); expect.poll does not retry a throw.
            return false;
          }
        }),
      { timeout: 5000 },
    )
    .toBe(true);
  // Playwright keeps the crashed target; drive the reloaded page from the main process.
  const inPage = (script: string) =>
    app.evaluate(
      ({ BrowserWindow }, code) =>
        BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(code) as Promise<unknown>,
      script,
    );
  await expect
    .poll(() =>
      inPage(
        `(() => { const row = document.querySelector('[data-testid="session-row"][data-session-id="${id}"] [data-testid="session-title"]'); row?.click(); return row !== null; })()`,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => inPage(`document.querySelectorAll('[data-testid="user-message"]').length`))
    .toBeGreaterThan(0);
});
