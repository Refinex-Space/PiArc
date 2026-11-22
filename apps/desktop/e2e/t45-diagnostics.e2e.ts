// T45-A08 (THR-04): the diagnostic bundle on the diagnostics page. "Prepare bundle…" shows the
// files, what was replaced and what is never included; nothing is written until the user picks a
// place in the main process's save dialog (stubbed here: Playwright cannot click native
// dialogs); the written archive holds exactly the listed files, without the credential in the
// user's settings, without session content and with the home folder as `~`. Screenshots go to
// tmp/evidence/T45/.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T45');
const SECRET = 'l4-settings-env-secret-7a6b';

async function openDiagnostics(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  await settings.getByTestId('settings-nav-diagnostics').click();
  await settings.getByTestId('config-diagnostics').waitFor();
  return settings;
}

/** The save dialog answers `chosen` (null: cancelled) and records that it was shown. */
async function stubSave(app: ElectronApplication, chosen: string | null): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    const g = globalThis as { __piarcSaves?: number };
    g.__piarcSaves = 0;
    dialog.showSaveDialog = () => {
      g.__piarcSaves = (g.__piarcSaves ?? 0) + 1;
      return Promise.resolve(
        target === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: target },
      );
    };
  }, chosen);
}

/** Names and contents of the stored entries of the ZIP archive Core writes. */
function entries(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.set(name, bytes.subarray(start, start + size).toString('utf8'));
    at = start + size;
  }
  return out;
}

test('the diagnostic bundle shows what it holds and is written only where the user chooses', async ({
  app,
  page,
  userDataDir,
}) => {
  test.setTimeout(90_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  await writeFile(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      mcpServers: { tools: { command: 'node', env: { TOKEN: SECRET } } },
      language: 'en',
    }),
  );
  await mkdir(path.join(userDataDir, 'pi', 'sessions', 'w'), { recursive: true });
  await writeFile(
    path.join(userDataDir, 'pi', 'sessions', 'w', 's.jsonl'),
    '{"text":"l4-session-content-marker"}\n',
  );
  const settings = await openDiagnostics(app, page);
  const section = settings.getByTestId('diagnostic-bundle');
  await section.scrollIntoViewIfNeeded();

  await section.getByTestId('diagnostic-bundle-prepare').click();
  const preview = section.getByTestId('diagnostic-bundle-preview');
  await expect(preview).toBeVisible();
  const files = preview.getByTestId('diagnostic-bundle-files');
  await expect(files).toContainText('versions.json');
  await expect(files).toContainText('settings/settings.json');
  await expect(files).toContainText(/logs\/core-\d{4}-\d{2}-\d{2}\.log/u);
  await expect(preview.getByTestId('diagnostic-bundle-redactions')).toContainText(
    'credential or secret value',
  );
  await expect(preview.getByTestId('diagnostic-bundle-excluded')).toContainText('secrets.vault');
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostic-bundle-preview.png') });
  const listed = (await files.locator('li code').allTextContents()).sort();

  // Cancelled in the save dialog: nothing is written, the preview stays.
  await stubSave(app, null);
  await preview.getByTestId('diagnostic-bundle-export').click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __piarcSaves?: number }).__piarcSaves))
    .toBe(1);
  await expect(preview).toBeVisible();

  const dir = path.join(os.tmpdir(), `piarc t45 bundle 诊断 ${String(process.pid)}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const target = path.join(dir, 'piarc-diagnostics.zip');
    await stubSave(app, target);
    await preview.getByTestId('diagnostic-bundle-export').click();
    await expect(section.getByTestId('diagnostic-bundle-exported')).toContainText(target);
    await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostic-bundle-exported.png') });

    const archive = entries(await readFile(target));
    expect([...archive.keys()].filter((n) => n !== 'manifest.json').sort()).toEqual(listed);
    const home = os.homedir();
    for (const [name, text] of archive) {
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain('l4-session-content-marker');
      expect(text, name).not.toContain(home);
      expect(name).not.toMatch(/vault|sqlite|sessions\//u);
    }
    expect(archive.get('settings/settings.json')).toContain('[REDACTED:secret]');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
