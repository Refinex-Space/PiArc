// Voice dictation in the real app (ADR-0094–0097, voice dictation addendum V-9.5): a
// development build records from `PIARC_TEST_SPEECH_SOURCE`, a real-speech WAV played at
// real-time pace into the same pipeline a microphone feeds (capture queue, resampling, the
// streaming model, the editor). The system's microphone permission is replaced by the test
// hook `setMicrophone`, so nothing here asks macOS for the microphone.
//
// Needs the speech assets of the source tree: `node scripts/dev/fetch-speech-assets.mjs`
// (`package:desktop` runs it). Screenshots go to tmp/evidence/<task>/l4/.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { closeSettings, openSettings } from './settings-panel.js';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle } from './t19.js';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const SPEECH = path.join(REPO, 'target', 'speech-assets');
/** 10.05 s of mixed Chinese and English: 昨天是 Monday, today is 礼拜二, … 是星期三. */
const SOURCE = path.join(SPEECH, 'test-wavs', '0.wav');

test.use({ appEnv: { PIARC_TEST_SPEECH_SOURCE: SOURCE } });

test.beforeAll(() => {
  const assets = path.join(SPEECH, `${process.platform}-${process.arch}`);
  if (!existsSync(SOURCE) || !existsSync(assets)) {
    throw new Error(`speech assets missing: run node scripts/dev/fetch-speech-assets.mjs`);
  }
});

async function setMicrophone(
  app: ElectronApplication,
  state: 'granted' | 'denied' | 'not-determined',
  grant = false,
): Promise<void> {
  await app.evaluate(
    (_electron, [value, allow]) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) throw new Error('no test hooks: package a development build');
      hooks.setMicrophone(value, allow);
    },
    [state, grant] as const,
  );
}

async function microphoneRequests(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.microphoneRequests() ?? -1);
}

/** The editor's visible text, the running hypothesis included (`home-input` before a session). */
function editorText(page: Page, testId = 'composer-input'): Promise<string> {
  return page.getByTestId(testId).innerText();
}

async function userSettings(userDataDir: string): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(userDataDir, 'settings.json'), 'utf8').catch(() => '{}');
  return JSON.parse(text) as Record<string, unknown>;
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(
    (value) => window.piarc.setPreference({ key: 'appearance.theme', value }),
    theme,
  );
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
}

test('voice: dictates into a session, keeps the words on Escape and sends them with Enter', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(150_000);
  await setMicrophone(app, 'not-determined', true);
  const ws = await makeWorkspace(workspaces, 'voice 语音');
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat');
  await idle(page);

  // The microphone sits between the editor and send; send keeps its own look.
  const mic = page.getByTestId('composer-mic');
  await expect(mic).toBeVisible();
  const micBox = await mic.boundingBox();
  const sendBox = await page.getByTestId('composer-send').boundingBox();
  if (micBox === null || sendBox === null) throw new Error('composer buttons are not visible');
  expect(micBox.x).toBeLessThan(sendBox.x);
  await page.screenshot({ path: testInfo.outputPath('voice-idle.png') });

  await mic.click();
  const strip = page.getByTestId('composer-dictation');
  await expect(strip).toHaveAttribute('data-state', 'recording', { timeout: 30_000 });
  // Asked once, granted, never again.
  expect(await microphoneRequests(app)).toBe(1);
  const recordingAt = Date.now();
  await expect(page.getByTestId('dictation-stop')).toBeVisible();
  await expect(page.getByTestId('dictation-waveform')).toBeVisible();
  await expect(page.getByTestId('dictation-elapsed')).toHaveText(/^\d+:\d{2}$/u);
  // Words appear while the speaker is still talking (the file lasts 10 s).
  await expect.poll(() => editorText(page), { timeout: 8_000 }).toContain('昨天');
  const firstWords = Date.now() - recordingAt;
  await page.screenshot({ path: testInfo.outputPath('voice-recording.png') });
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toMatch(/星期三/u);

  // Escape stops and keeps the text; nothing is sent.
  await page.getByTestId('composer-input').press('Escape');
  await expect(strip).toHaveCount(0, { timeout: 15_000 });
  const kept = await editorText(page);
  expect(kept).toMatch(/昨天是/u);
  expect(kept.toLowerCase()).toContain('monday');
  expect(kept).toMatch(/星期三/u);
  await expect(page.getByTestId('composer-mic')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('voice-kept.png') });

  // Enter sends the dictated words as the next message.
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('transcript-scroller').getByText('Second answer.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('user-message').filter({ hasText: '星期三' })).toHaveCount(1);
  // An empty editor is one empty paragraph (`<p><br></p>`).
  await expect.poll(async () => (await editorText(page)).trim()).toBe('');
  console.log(`voice L4: first words ${String(firstWords)} ms after recording began`);
});

test('voice: × removes what dictation wrote in one undo step; typed text stays', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  await setMicrophone(app, 'granted');
  const ws = await makeWorkspace(workspaces, 'voice cancel');
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat');
  await idle(page);
  const input = page.getByTestId('composer-input');
  await input.click();
  await page.keyboard.type('前缀 ');
  await page.getByTestId('composer-mic').click();
  await expect(page.getByTestId('composer-dictation')).toHaveAttribute('data-state', 'recording', {
    timeout: 30_000,
  });
  // Wait for the last words to be committed (the source plays silence after the file, so the
  // endpoint closes the segment): a running hypothesis is never in the undo history.
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toMatch(/星期三/u);
  await expect(page.locator('.dictation-partial')).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath('voice-before-cancel.png') });
  await page.getByTestId('dictation-cancel').click();
  await expect(page.getByTestId('composer-dictation')).toHaveCount(0);
  await expect.poll(() => editorText(page)).toBe('前缀 ');
  // One undo step brings the dictated text back.
  await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(() => editorText(page)).toMatch(/^前缀 .*星期三/su);
});

test('voice: a refused microphone says so and offers the system settings', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  await setMicrophone(app, 'denied');
  const ws = await makeWorkspace(workspaces, 'voice denied');
  await openFolder(page, app, ws);
  await page.getByTestId('home-input').click();
  await page.keyboard.type('草稿');
  await page.getByTestId('composer-mic').click();
  const strip = page.getByTestId('composer-dictation');
  await expect(strip).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('dictation-status')).toContainText(
    /cannot use the microphone|无法使用麦克风/u,
  );
  await expect(page.getByTestId('dictation-open-system')).toBeVisible();
  // The draft is untouched and the system was not asked.
  expect(await editorText(page, 'home-input')).toBe('草稿');
  expect(await microphoneRequests(app)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('voice-denied.png') });
  await page.getByTestId('dictation-cancel').click();
  await expect(strip).toHaveCount(0);
});

test('voice: the settings page shows the models, tests the microphone and saves choices', async ({
  app,
  page,
  workspaces,
  userDataDir,
}, testInfo) => {
  test.setTimeout(120_000);
  await setMicrophone(app, 'granted');
  const ws = await makeWorkspace(workspaces, 'voice settings');
  await openFolder(page, app, ws);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const settings = await openSettings(page);
    await settings.getByTestId('settings-nav-voice').click();
    const voice = settings.getByTestId('voice-page');
    await expect(voice).toBeVisible();
    await expect(voice.getByTestId('voice-model-base-state')).toHaveText(/Ready|可用/u, {
      timeout: 30_000,
    });
    await expect(voice.getByTestId('voice-model-enhanced-state')).toHaveText(
      /Not installed|未安装/u,
    );
    await expect(voice.getByTestId('voice-download')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`voice-settings-${theme}.png`) });
    await closeSettings(settings);
  }
  await setTheme(page, 'light');

  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-voice').click();
  const voice = settings.getByTestId('voice-page');
  // Verify checks every file of the built-in model now (V-8.2).
  await voice.getByTestId('voice-verify-base').click();
  await expect(voice.getByTestId('voice-verified-base')).toBeVisible({ timeout: 30_000 });
  // The microphone test draws levels and never writes text.
  await voice.getByTestId('voice-test-button').click();
  await expect(voice.getByTestId('dictation-waveform')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('voice-settings-test.png') });
  await voice.getByTestId('voice-test-button').click();
  await expect(voice.getByTestId('dictation-waveform')).toHaveCount(0, { timeout: 15_000 });

  // Choices land in the user's settings; defaults are written as removals.
  // The checkbox follows the saved preference.
  await voice.getByTestId('voice-punctuation').click();
  await expect(voice.getByTestId('voice-punctuation')).not.toBeChecked();
  await voice.getByTestId('voice-term-input').fill('a/b');
  await voice.getByTestId('voice-term-add').click();
  await expect(voice.getByTestId('voice-term-error')).toBeVisible();
  await voice.getByTestId('voice-term-input').fill('PiArc');
  await voice.getByTestId('voice-term-add').click();
  await expect(voice.getByTestId('voice-term')).toHaveText(/PiArc/u);
  await expect
    .poll(async () => (await userSettings(userDataDir)).voiceDictation)
    .toEqual({ punctuation: false, customTerms: ['PiArc'] });

  // Turning voice input off takes the microphone away from the composer.
  await voice.getByTestId('voice-enabled').click();
  await expect(voice.getByTestId('voice-enabled')).not.toBeChecked();
  await closeSettings(settings);
  await expect(page.getByTestId('composer-mic')).toHaveCount(0);
  const reopened = await openSettings(page);
  await reopened.getByTestId('settings-nav-voice').click();
  await reopened.getByTestId('voice-enabled').click();
  await expect(reopened.getByTestId('voice-enabled')).toBeChecked();
  await closeSettings(reopened);
  await expect(page.getByTestId('composer-mic')).toBeVisible();
});
