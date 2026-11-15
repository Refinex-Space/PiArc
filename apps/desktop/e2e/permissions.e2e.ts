// A10: permission requests that are not on the allowlist (empty in T03) are denied.
import { expect, test } from './fixtures.js';

// Fake capture devices, so the camera request reaches the permission handler on machines and
// CI runners without a camera. (The fake *UI* switch is not used: it would auto-accept.)
test.use({ appArgs: ['--use-fake-device-for-media-stream'] });

test('denies notifications', async ({ page, appLog }) => {
  const result = await page.evaluate(async () => ({
    requested: await Notification.requestPermission(),
    current: Notification.permission,
  }));
  expect(result).toEqual({ requested: 'denied', current: 'denied' });
  await appLog.waitFor(/\[security\] denied permission request notifications from app:\/\/piarc/);
});

test('denies the camera', async ({ page, appLog }) => {
  const outcome = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return 'granted';
    } catch (error) {
      return error instanceof DOMException ? error.name : String(error);
    }
  });
  expect(outcome).toBe('NotAllowedError');
  await appLog.waitFor(/\[security\] denied permission request media from app:\/\/piarc/);
});

test('denies geolocation', async ({ page, appLog }) => {
  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => {
            resolve('granted');
          },
          (error) => {
            resolve(error.code === error.PERMISSION_DENIED ? 'PERMISSION_DENIED' : error.message);
          },
          { timeout: 10_000 },
        );
      }),
  );
  expect(outcome).toBe('PERMISSION_DENIED');
  await appLog.waitFor(/\[security\] denied permission request geolocation from app:\/\/piarc/);
});

test('reports the permissions as denied to permission queries', async ({ page }) => {
  const states = await page.evaluate(async () => {
    const names: PermissionName[] = ['notifications', 'geolocation', 'camera', 'microphone'];
    return Promise.all(
      names.map(async (name) => `${name}: ${(await navigator.permissions.query({ name })).state}`),
    );
  });
  expect(states).toEqual([
    'notifications: denied',
    'geolocation: denied',
    'camera: denied',
    'microphone: denied',
  ]);
});
