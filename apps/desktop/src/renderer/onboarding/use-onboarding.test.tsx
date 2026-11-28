// @vitest-environment happy-dom
// When the first-run guide opens by itself, and what closes it (ADR-0110).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { AppStore } from '../store/app-store.js';
import { useOnboarding, type OnboardingControl } from './use-onboarding.js';

let root: Root;
let host: HTMLDivElement;
let control: OnboardingControl | undefined;

function Probe({ store }: { readonly store: AppStore }) {
  control = useOnboarding(store, false);
  return <>{control.layer}</>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', {
    providerSettings: () => new Promise(() => undefined),
    setPreference: vi.fn(),
    onAppEvent: () => () => undefined,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  control = undefined;
});

function render(store: AppStore) {
  act(() => {
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
        <Probe store={store} />
      </AppProvider>,
    );
  });
}

const guide = () => host.querySelector('[data-testid="onboarding"]');
const cover = () => host.querySelector('[data-testid="onboarding-cover"]');

it('covers the window until the workspaces are known, then opens the welcome', () => {
  const store = new AppStore();
  render(store);
  expect(cover()).not.toBeNull();
  expect(control?.covering).toBe(true);
  act(() => {
    store.applyWorkspaces({ revision: 1, workspaces: [] });
  });
  expect(cover()).toBeNull();
  expect(guide()?.getAttribute('data-step')).toBe('welcome');
});

it('stays closed for a user who already has a workspace', () => {
  const store = new AppStore();
  render(store);
  act(() => {
    store.applyWorkspaces({ revision: 1, workspaces: [{ path: '/project' }] });
  });
  expect(guide()).toBeNull();
  expect(control?.covering).toBe(false);
});

it('closes the guide it opened when a link or a dropped folder arrives afterwards', () => {
  const store = new AppStore();
  render(store);
  act(() => {
    store.applyWorkspaces({ revision: 1, workspaces: [] });
  });
  expect(guide()).not.toBeNull();
  act(() => {
    control?.noteLaunch();
  });
  expect(guide()).toBeNull();
  expect(control?.covering).toBe(false);
});
