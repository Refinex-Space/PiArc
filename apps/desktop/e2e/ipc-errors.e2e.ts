// I236: a Core error keeps its kind on the way to the page (the main process writes it in front
// of the message, `src/main/ipc/page-errors.ts`), so the window can describe it in its own
// language; the main process's own argument checks still read as written.
import { expect, test } from './fixtures.js';

test('a Core error reaches the page with its kind; argument checks do not get one', async ({
  page,
}) => {
  const [core, checked] = await page.evaluate(async () => {
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    return [
      await window.piarc.sessionModels('not-an-open-session').then(
        () => 'resolved',
        (error: unknown) => message(error),
      ),
      await window.piarc.sessionModels('').then(
        () => 'resolved',
        (error: unknown) => message(error),
      ),
    ];
  });
  expect(core).toMatch(
    /^Error invoking remote method 'piarc:[A-Za-z.]+': Error: \[piarc:sessionNotFound\] .+/su,
  );
  expect(checked).toMatch(/^Error invoking remote method 'piarc:[A-Za-z.]+': TypeError: /u);
  expect(checked).not.toContain('[piarc:');
});
