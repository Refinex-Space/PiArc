// The Git tool (ADR-0084, formerly T28's Changes panel) and its rail card: the card in the
// session rail (every session, after the context card) and the tool in the dock while it is
// open (the card heading's icon or branch, Mod+Shift+D). Outside a Git repository both show the session's own
// changes as before.
import { registerPanel } from '../shell/registry.js';
import { GitCard, OpenGitAction } from './git/GitCard.js';
import { GitPanel } from './git/GitPanel.js';

registerPanel({
  id: 'changes-card',
  area: 'rail',
  title: 'panel.changes',
  order: 60,
  when: (context) => context.sessionId !== undefined,
  render: (context) =>
    context.sessionId === undefined ? null : <GitCard sessionId={context.sessionId} />,
  actions: () => <OpenGitAction />,
});

registerPanel({
  id: 'changes',
  area: 'tool',
  title: 'panel.changes',
  order: 30,
  when: (context) => context.sessionId !== undefined,
  render: (context) =>
    context.sessionId === undefined ? null : <GitPanel sessionId={context.sessionId} />,
});
