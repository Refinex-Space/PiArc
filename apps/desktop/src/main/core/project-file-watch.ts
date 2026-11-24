// OS watches carry invalidations only. The next listing / document read always goes through Core.
import { watch, type FSWatcher } from 'node:fs';
import type { WebContents } from 'electron';
import { APP_EVENT_CHANNEL, IPC_CHANNELS, isSessionId, type AppEvent } from '../../shared/ipc.js';
import { isProjectPath, projectRecord } from '../../shared/project-files.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

export function registerProjectWatch(
  register: RegisterHandler,
  core: Pick<CoreRuntime, 'projectFiles'>,
) {
  const owners = new WeakMap<
    WebContents,
    { generation: number; watchers: FSWatcher[]; timer?: NodeJS.Timeout }
  >();
  register(IPC_CHANNELS.projectFileWatch, async ({ sender, senderFrame }, [id, paths]) => {
    if (
      senderFrame !== sender.mainFrame ||
      !isSessionId(id) ||
      !Array.isArray(paths) ||
      paths.length > 66 ||
      !paths.every((p: unknown) => isProjectPath(p, true))
    )
      throw new TypeError('Invalid project watch');
    let state = owners.get(sender);
    if (!state) {
      state = { generation: 0, watchers: [] };
      owners.set(sender, state);
      const current = state;
      const reset = () => {
        current.generation++;
        current.watchers.splice(0).forEach((w) => {
          w.close();
        });
        clearTimeout(current.timer);
      };
      sender.once('destroyed', reset);
      sender.on('render-process-gone', reset);
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) reset();
      });
    }
    const current = state;
    const revision = ++current.generation;
    current.watchers.splice(0).forEach((w) => {
      w.close();
    });
    clearTimeout(current.timer);
    const changed = () => {
      if (revision !== current.generation) return;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        if (!sender.isDestroyed())
          sender.send(APP_EVENT_CHANNEL, {
            type: 'projectFilesChanged',
            sessionId: id,
          } satisfies AppEvent);
      }, 160);
    };
    await Promise.all(
      [...new Set(paths)].map(async (p) => {
        try {
          const item: unknown = JSON.parse(
            await core.projectFiles(id, JSON.stringify({ op: 'resolve', path: p })),
          );
          if (
            revision !== current.generation ||
            !projectRecord(item) ||
            typeof item.path !== 'string'
          )
            return;
          const watcher = watch(item.path, { persistent: false }, changed);
          watcher.on('error', (e) => {
            console.warn('[files] watch unavailable', e.name);
            watcher.close();
            changed();
          });
          current.watchers.push(watcher);
        } catch (error) {
          if (revision === current.generation)
            console.warn(
              '[files] could not watch project entry',
              error instanceof Error ? error.name : 'Error',
            );
        }
      }),
    );
  });
}
