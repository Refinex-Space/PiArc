// The sandbox in the environment bar (T39): a tag while the workspace's commands run in the
// sandbox, and a warning when the settings turn it on but it does not apply (Windows has no
// sandbox, requirement D7; on macOS `sandbox-exec` may be missing or fail, risk R10). Read from
// Core's `sandboxSettings` when the session's workspace changes and whenever the window comes
// back to the front (the settings window is where the sandbox is changed).
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { useWindowFocused } from '../app/window-focus.js';
import { parseSandboxView, type SandboxView } from '../settings/SandboxPage.js';

export function SandboxStatus({ workspace }: { readonly workspace: string | undefined }) {
  const t = useT();
  const focused = useWindowFocused();
  const [view, setView] = useState<SandboxView>();
  useEffect(() => {
    if (workspace === undefined) return;
    let current = true;
    window.piarc
      .sandboxSettings(workspace)
      .then((raw) => {
        if (current) setView(parseSandboxView(raw));
      })
      .catch((error: unknown) => {
        console.error('[sandbox] reading the sandbox settings failed', error);
      });
    return () => {
      current = false;
    };
  }, [workspace, focused]);
  if (view?.enabled !== true) return null;
  if (!view.supported || !view.available) {
    return (
      <span className="tag sandbox-warning" role="status" data-testid="env-sandbox-warning">
        {t(view.supported ? 'sandbox.notice.unavailable' : 'sandbox.notice.platform')}
      </span>
    );
  }
  return (
    <span className="tag" data-testid="env-sandbox" title={t('sandbox.intro')}>
      {t('sandbox.badge')}
    </span>
  );
}
