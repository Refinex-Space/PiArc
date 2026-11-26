// @vitest-environment happy-dom
// B5.1: the site menu's import names its host for the Browser settings page. That page's first
// render can suspend; a render React throws away must not use up the target.
import { act, Suspense, use } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { rememberImportTarget, useImportTarget } from './browser-import-target.js';

let resolveReady: () => void = () => undefined;
const loading = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

function Page() {
  const target = useImportTarget();
  // Suspends on its first render, as a lazily loaded part of the page does.
  use(loading);
  return <p data-host={target?.host ?? ''} />;
}

it('keeps the target through a suspended first render and uses it up once shown', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rememberImportTarget({ host: 'github.com', workspace: '/w' });
  const element = document.createElement('div');
  const root = createRoot(element);
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <Page />
      </Suspense>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    resolveReady();
    await loading;
  });
  expect(element.querySelector('p')?.dataset.host).toBe('github.com');
  expect(window.sessionStorage.getItem('piarc.browserImportTarget')).toBeNull();
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
});
