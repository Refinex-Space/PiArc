// T26's panels: the task card in the session rail while the session has a task list, the plan
// tile in the dock while it has a plan (waiting for review or approved).
import { PlanPanel } from '../approvals/PlanPanel.js';
import { TaskPanel } from '../transcript/TaskPanel.js';
import { registerPanel } from './registry.js';

registerPanel({
  id: 'tasks',
  area: 'rail',
  title: 'panel.tasks',
  order: 40,
  when: (context) => context.sessionId !== undefined && context.tasks === true,
  render: (context) => <TaskPanel sessionId={context.sessionId} />,
});

registerPanel({
  id: 'plan',
  area: 'dock',
  title: 'panel.plan',
  order: 40,
  when: (context) => context.sessionId !== undefined && context.plan === true,
  render: (context) => <PlanPanel sessionId={context.sessionId} />,
});
