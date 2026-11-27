// Ported from ego-browser package/ego-browser/src/index.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: only the embedded-SDK path: installEgoSdk wraps the bindings (createTab,
// useTaskSpace and the session-invalidating calls) and disposeEgoSdk releases them; the CLI entry
// (runMain), the update notice, the 1.3 skill guard and the globals for helpers and console are
// not ported (run.ts passes helpers to the script as parameters).

import {
  clearPreferredTarget,
  disposeBrowserRuntime,
  invalidateSession,
  setPreferredTarget,
} from './browser-runtime.js';
import { disposeDownloadArtifacts } from './driver/downloads.js';
import type { EgoBindings } from './ego-bindings.js';

interface InstallTarget {
  ego?: EgoBindings | undefined;
}

/** Release native callbacks before the host discards the run. */
export function disposeEgoSdk(target: InstallTarget = globalThis): void {
  disposeDownloadArtifacts();
  disposeBrowserRuntime(target.ego);
}

// Marks bindings whose mutating methods have already been wrapped, so a second
// installEgoSdk call cannot double-wrap createTab / task-space methods.
const EGO_WRAPPED = Symbol.for('egoBrowser.sdkWrapped');

export function installEgoSdk(target: InstallTarget = globalThis): void {
  const ego = target.ego;
  if (!ego || Reflect.get(ego, EGO_WRAPPED) === true) {
    return;
  }
  const taskSelection: { spaceId?: number } = {};
  wrapCreateTab(ego);
  wrapUseTaskSpace(ego, taskSelection);
  wrapInvalidating(ego, () => {
    delete taskSelection.spaceId;
  });
  Object.defineProperty(ego, EGO_WRAPPED, {
    value: true,
    enumerable: false,
  });
}

function wrapInvalidating(ego: EgoBindings, resetSelection: () => void): void {
  const after = <T>(value: T): T => {
    resetSelection();
    invalidateSession();
    clearPreferredTarget();
    return value;
  };
  const closeTaskSpace = ego.closeTaskSpace.bind(ego);
  const createTaskSpace = ego.createTaskSpace.bind(ego);
  const claimTaskSpace = ego.claimTaskSpace.bind(ego);
  ego.closeTaskSpace = () => closeTaskSpace().then(after);
  ego.createTaskSpace = (...args) => createTaskSpace(...args).then(after);
  ego.claimTaskSpace = (...args) => claimTaskSpace(...args).then(after);
}

function wrapUseTaskSpace(ego: EgoBindings, selection: { spaceId?: number }): void {
  // File chooser waits and other event subscriptions span multiple Page calls.
  // Re-selecting the same space must preserve their CDP session; changing the
  // space still invalidates every session because the selection is global.
  const original = ego.useTaskSpace.bind(ego);
  ego.useTaskSpace = (spaceId) => {
    const result = original(spaceId);
    if (selection.spaceId !== spaceId) {
      invalidateSession();
      clearPreferredTarget();
      selection.spaceId = spaceId;
    }
    return result;
  };
}

function wrapCreateTab(ego: EgoBindings): void {
  const original = ego.createTab.bind(ego);
  ego.createTab = (url) =>
    original(url).then((value) => {
      if ('targetId' in value && value.targetId) setPreferredTarget(value.targetId);
      return value;
    });
}
