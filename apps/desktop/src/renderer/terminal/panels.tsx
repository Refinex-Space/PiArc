// T34's panel: the terminal panel in the dock while it is open (Ctrl+`) for a session.
import { registerPanel } from '../shell/registry.js';
import { TerminalPanel } from './TerminalPanel.js';

registerPanel({
  id: 'terminal',
  area: 'tool',
  title: 'panel.terminal',
  // First in the dock: it is the panel people keep open.
  order: 5,
  when: (context) => context.sessionId !== undefined,
  render: (context) =>
    context.sessionId === undefined ? null : (
      <TerminalPanel key={context.sessionId} sessionId={context.sessionId} />
    ),
});
