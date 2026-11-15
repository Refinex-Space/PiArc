// Placeholder of the three-column window skeleton (architecture section 8.2). The real shell,
// session list and panels arrive with T18; design tokens with T18 as well.
import { useEffect, useState } from 'react';

export function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.piarc.getAppVersion().then(
      (value) => {
        if (active) {
          setVersion(value);
        }
      },
      (error: unknown) => {
        console.error('Failed to read the app version', error);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="shell" data-testid="app-shell">
      <aside className="shell-sidebar" data-testid="shell-sidebar" aria-label="Sessions">
        <h2 className="shell-heading">Sessions</h2>
        <p className="shell-placeholder">No sessions yet</p>
        <footer className="shell-footer" data-testid="app-version">
          {version === null ? 'PiArc' : `PiArc ${version}`}
        </footer>
      </aside>
      <main className="shell-main" data-testid="shell-main" aria-label="Conversation">
        <h1 className="shell-heading">Conversation</h1>
        <p className="shell-placeholder">Transcript and composer arrive in later tasks</p>
      </main>
      <aside className="shell-panel" data-testid="shell-panel" aria-label="Details">
        <h2 className="shell-heading">Details</h2>
        <p className="shell-placeholder">Changes, terminal and tasks</p>
      </aside>
    </div>
  );
}
