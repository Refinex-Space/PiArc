// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/preferences.js';
import { AppProvider } from '../../app/app-context.js';
import { MarketDetail } from './MarketDetail.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('shows a package, its warnings and its README as Markdown with raw HTML as text', async () => {
  vi.useFakeTimers();
  // Code blocks start the highlighter's worker; happy-dom has none.
  vi.stubGlobal(
    'Worker',
    class extends EventTarget {
      postMessage(): void {
        // Highlighting never answers here; the block shows its plain text.
      }
      terminate(): void {
        // Nothing runs.
      }
    },
  );
  const detail = vi.fn().mockResolvedValue(
    JSON.stringify({
      entry: {
        name: 'pi-lint-skills',
        version: '1.2.0',
        description: 'Lint',
        kinds: ['skill', 'theme'],
        downloadsMonthly: 12400,
        installed: { id: 'pi-lint-skills', enabled: true, scope: 'user' },
      },
      license: 'MIT',
      repositoryUrl: 'https://github.com/example/pi-lint-skills',
      readme:
        '# pi-lint-skills\n\nRuns **lint**.\n\n<script>x</script>\n\n```sh\nnpm run lint\n```\n',
      installScripts: ['postinstall'],
      dependencies: ['a'],
    }),
  );
  Object.assign(window, { piarc: { marketDetail: detail, onAppEvent: () => () => undefined } });
  const dom = document.createElement('div');
  document.body.append(dom);
  const root = createRoot(dom);
  await act(async () => {
    root.render(
      <AppProvider
        initial={{
          platform: 'darwin',
          preferences: DEFAULT_PREFERENCES,
          locale: 'en',
          focused: true,
          notificationsSupported: true,
        }}
      >
        <MarketDetail
          name="pi-lint-skills"
          target={{ workspace: null, trusted: false }}
          busy={false}
          run={() => undefined}
          revision={0}
        />
      </AppProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(dom.querySelector('.catalog-detail-title h3')?.textContent).toBe('pi-lint-skills');
  const readme = dom.querySelector('[data-testid="market-readme"]');
  expect(readme?.textContent).toContain('Runs lint.');
  expect(readme?.textContent).toContain('<script>x</script>');
  expect(readme?.textContent).toContain('npm run lint');
  expect(dom.querySelector('script')).toBeNull();
  const warnings = dom.querySelector('[data-testid="market-warnings"]')?.textContent ?? '';
  expect(warnings).toContain('postinstall');
  expect(warnings).toContain('themes');
  expect(dom.querySelector('[data-testid="package-uninstall-start"]')).toBeTruthy();
  act(() => {
    root.unmount();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
