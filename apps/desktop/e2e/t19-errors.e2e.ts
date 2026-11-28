// T19-A08: failures injected along the real path — the provider refusing the credentials, a rate
// limit that outlasts the automatic retries (then a manual retry), the Agent Host killed during a
// turn (the "outcome unknown" card and its retry), and a message Core never received, sent again
// once without showing twice.
import { IPC_CHANNELS } from '../src/shared/ipc.js';
import { expectTestHooks } from './core.js';
import { expect, test } from './sessions.js';
import {
  idle,
  killAgentHost,
  openSession,
  requests,
  roles,
  screenshots,
  send,
  userTexts,
} from './t19.js';

test('an authentication failure is an error card without a retry', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  await openSession(app, page, workspaces, 'auth 认证', 't19-auth', 'Hello');
  const card = page.getByTestId('error-card');
  await expect(card).toHaveAttribute('data-kind', 'auth', { timeout: 20_000 });
  await expect(card.getByTestId('error-title')).toHaveText('Authentication failed');
  await expect(card.getByTestId('error-retry')).toHaveCount(0);
  await screenshots(page, testInfo, 'error-auth');
});

test('a rate limit past the automatic retries offers a retry that works', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  await openSession(app, page, workspaces, 'limit 限流', 't19-limit', 'Hello');
  const card = page.getByTestId('error-card');
  await expect(card).toHaveAttribute('data-kind', 'rateLimit', { timeout: 30_000 });
  await expect(card).toHaveAttribute('data-retryable', 'true');
  await screenshots(page, testInfo, 'error-rate-limit');
  await card.getByTestId('error-retry').click();
  await expect(page.getByTestId('agent-message')).toContainText('Answered after the retry.', {
    timeout: 20_000,
  });
  // Pi's three automatic retries, then the manual one.
  const wire = await requests(mock, 't19-limit');
  expect(wire).toHaveLength(5);
  // I67: Pi omits the failed assistant response. Check the exact role sequence.
  expect(wire.map(roles)).toEqual([['user'], ['user'], ['user'], ['user'], ['user', 'user']]);
});

test('the Agent Host dying mid-turn leaves an "outcome unknown" card whose retry works', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(90_000);
  await openSession(app, page, workspaces, 'host 中断', 't19-host', 'Start the long job');
  await expect(page.getByTestId('agent-message')).toContainText('Working on it', {
    timeout: 20_000,
  });
  await killAgentHost(app);
  const card = page.getByTestId('uncertain-card');
  await expect(card).toContainText('Connection interrupted, the turn’s outcome is unknown', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('working-row')).toHaveCount(0);
  await screenshots(page, testInfo, 'uncertain');
  await card.getByTestId('uncertain-retry').click();
  await expect(page.getByTestId('agent-message').last()).toContainText(
    'Answered after the restart.',
    { timeout: 30_000 },
  );
});

test('a message Core did not take is marked and sent again only once', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  await expectTestHooks(app);
  await openSession(app, page, workspaces, 'resend 重发', 't19-chat', 'Hello');
  await idle(page);
  await app.evaluate((_electron, channel) => {
    globalThis.__piarcTestHooks?.failNext(channel, 'the main process dropped the message');
  }, IPC_CHANNELS.sessionPrompt);
  await send(page, 'Second question');
  const undelivered = page.getByTestId('undelivered');
  await expect(undelivered).toContainText('Not delivered: the main process dropped the message');
  await screenshots(page, testInfo, 'undelivered');
  await page.getByTestId('resend').click();
  await expect(page.getByTestId('agent-message').last()).toContainText('Second.', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('user-message').filter({ hasText: 'Second question' })).toHaveCount(
    1,
  );
  await expect(undelivered).toHaveCount(0);
  const sent = await requests(mock, 't19-chat');
  expect(sent).toHaveLength(2);
  expect(userTexts(sent[1]?.body ?? {}).filter((text) => text === 'Second question')).toHaveLength(
    1,
  );
});
