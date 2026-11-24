// T32's panels: the background task card in the session rail while the session has tasks, and
// the dockable background task panel on explicit request, including its empty state.
import { TasksCard, TasksPanel } from './BackgroundTasks.js';
import { registerPanel } from './registry.js';

registerPanel({
  id: 'background-tasks-card',
  initiallyExpanded: true,
  area: 'rail',
  title: 'panel.backgroundTasks',
  // After the task list, before the context card.
  order: 45,
  when: (context) => context.sessionId !== undefined && context.backgroundTasks === true,
  render: (context) =>
    context.sessionId === undefined ? null : <TasksCard sessionId={context.sessionId} />,
});

registerPanel({
  id: 'background-tasks',
  area: 'dock',
  title: 'panel.backgroundTasks',
  order: 45,
  when: (context) => context.sessionId !== undefined,
  render: (context) => <TasksPanel sessionId={context.sessionId} />,
});
