// Feeds the store from Core's event channel (`window.piarc.subscribeEvents`): the entity
// snapshots, notices, and the routes of the sessions a view watches. Batches are UTF-8 JSON
// arrays of events (architecture section 7.6).
import type { EventBatch, PiarcApi } from '../../shared/ipc.js';
import type { AppStore } from './app-store.js';

const decoder = new TextDecoder();

function eventsOf(batch: EventBatch): unknown[] {
  try {
    const events: unknown = JSON.parse(decoder.decode(batch.payload));
    return Array.isArray(events) ? events : [];
  } catch (error) {
    console.error(`[store] ignored a batch on ${batch.route} that is not JSON`, error);
    return [];
  }
}

export class StoreConnection {
  private readonly watched = new Map<string, number>();

  constructor(
    private readonly store: AppStore,
    private readonly api: Pick<
      PiarcApi,
      'subscribeEvents' | 'unsubscribeEvents' | 'resendSnapshots'
    >,
  ) {}

  /** Subscribes the entity routes and asks Core for the current snapshots. */
  async start(): Promise<void> {
    await Promise.all([
      this.api.subscribeEvents('core/workspaces', (batch) => {
        for (const event of eventsOf(batch)) {
          this.store.applyWorkspaces(event);
        }
      }),
      this.api.subscribeEvents('core/sessions', (batch) => {
        for (const event of eventsOf(batch)) {
          this.store.applySessions(event);
        }
      }),
      this.api.subscribeEvents('core/notices', (batch) => {
        for (const event of eventsOf(batch)) {
          this.store.applyNotice(event);
        }
      }),
      this.api.subscribeEvents('core/tasks', (batch) => {
        for (const event of eventsOf(batch)) {
          this.store.tasks.apply(event);
        }
      }),
    ]);
    await this.api.resendSnapshots();
  }

  /** Receives session `id`'s notifications until the returned function is called. */
  watchSession(id: string): () => void {
    const route = `session/${id}`;
    const count = this.watched.get(route) ?? 0;
    this.watched.set(route, count + 1);
    if (count === 0) {
      this.api
        .subscribeEvents(route, (batch) => {
          this.store.transcript(id).apply(eventsOf(batch));
        })
        .catch((error: unknown) => {
          console.error(`[store] cannot watch ${route}`, error);
        });
    }
    return () => {
      const left = (this.watched.get(route) ?? 1) - 1;
      if (left > 0) {
        this.watched.set(route, left);
        return;
      }
      this.watched.delete(route);
      this.api.unsubscribeEvents(route).catch((error: unknown) => {
        console.error(`[store] cannot stop watching ${route}`, error);
      });
    };
  }
}
