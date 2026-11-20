// T28's panels: the changes card in the session rail (every session, after the context card)
// and the Changes panel in the dock while it is open (the card's button, Mod+Shift+D).
import { registerPanel } from '../shell/registry.js';
import { ChangesCard, ChangesPanel } from './ChangesPanel.js';

registerPanel({
  id: 'changes-card',
  area: 'rail',
  title: 'panel.changes',
  order: 60,
  when: (context) => context.sessionId !== undefined,
  render: (context) =>
    context.sessionId === undefined ? null : <ChangesCard sessionId={context.sessionId} />,
});

registerPanel({
  id: 'changes',
  area: 'dock',
  title: 'panel.changes',
  order: 30,
  when: (context) => context.sessionId !== undefined && context.changes === true,
  render: (context) =>
    context.sessionId === undefined ? null : <ChangesPanel sessionId={context.sessionId} />,
});
