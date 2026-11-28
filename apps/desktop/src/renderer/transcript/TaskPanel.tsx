// The rail's task card (T26): the selected session's current task list, from its harness state
// (the last TodoWrite of the branch, live and after reloads).
import { useT } from '../app/app-context.js';
import { useHarness } from '../store/hooks.js';
import { TaskList } from './rows/harness.js';

export function TaskPanel({ sessionId }: { readonly sessionId: string | undefined }) {
  const t = useT();
  const todos = useHarness(sessionId)?.todos ?? [];
  return (
    <div className="task-panel" data-testid="task-panel">
      {todos.length === 0 ? (
        <p className="muted">{t('tasks.empty')}</p>
      ) : (
        <TaskList todos={todos} />
      )}
    </div>
  );
}
