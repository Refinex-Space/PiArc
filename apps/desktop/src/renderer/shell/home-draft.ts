// The new-session view's tools before the first message (ADR-0099). The tools (files,
// terminal, changes, preview) work on a session, so the first time the user reaches for one
// the shell opens a draft session in the view's folder; the first message then goes to it and
// the tools stay as they are. A draft the view leaves without a message (another view, another
// folder, a worktree chosen) is discarded with its terminals. In a worktree the tools wait for
// the first message: the worktree is created when the message is sent. A tool asked for while
// the draft opens shows at once as a preparing tile (`opening`), replaced by the tool itself
// when the draft is there.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { PiarcApi } from '../../shared/ipc.js';
import { togglePanel } from './registry.js';
import type { View } from './ui.js';

export interface HomeTools {
  /** The draft session of the new-session view's folder, once opened. */
  readonly sessionId: string | undefined;
  /** Opens the draft (once) and resolves its id; absent when the view cannot have one. */
  readonly prepare: (() => Promise<string | undefined>) | undefined;
  /** Opens tool `id` of the draft, opening the draft first when needed. */
  readonly open: ((id: string) => void) | undefined;
  /** Tools asked for while the draft opens: their tiles show at once, preparing. */
  readonly opening: readonly string[];
  /** Takes tool `id` back before the draft opened (its preparing tile was closed). */
  readonly cancel: (id: string) => void;
  /** The view starts the session in a worktree: its tools wait for the first message. */
  readonly waiting: boolean;
  /** The new-session view reports its folder and whether it uses a worktree. */
  readonly report: (workspace: string | undefined, worktree: boolean) => void;
}

interface Environment {
  readonly workspace: string | undefined;
  readonly worktree: boolean;
}

interface Draft {
  readonly workspace: string;
  readonly id: string;
}

type DraftApi = Pick<PiarcApi, 'createDraftSession' | 'discardDraftSession'>;

const NONE: readonly string[] = [];

interface Opening {
  readonly workspace: string | undefined;
  readonly ids: readonly string[];
}

const NOTHING_ASKED: Opening = { workspace: undefined, ids: NONE };

function sessionIdOf(text: string): string | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value === 'object' && value !== null && 'sessionId' in value) {
    return typeof value.sessionId === 'string' ? value.sessionId : undefined;
  }
  return undefined;
}

function discard(api: DraftApi, id: string): void {
  api.discardDraftSession(id).catch((error: unknown) => {
    console.error('[home] cannot discard the draft session', error);
  });
}

export function useHomeTools(view: View, api: DraftApi): HomeTools {
  const [env, setEnv] = useState<Environment>({ workspace: undefined, worktree: false });
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState<readonly string[]>([]);
  // The tools asked for while the draft opens, and the folder they were asked in; the ref is
  // what promise callbacks read.
  const [opening, setOpening] = useState<Opening>(NOTHING_ASKED);
  const asked = useRef<Opening>(NOTHING_ASKED);
  const ask = useCallback((next: Opening) => {
    asked.current = next;
    setOpening(next);
  }, []);
  const without = useCallback(
    (id: string): Opening => ({
      ...asked.current,
      ids: asked.current.ids.filter((other) => other !== id),
    }),
    [],
  );
  const latest = useRef({ view, env, draft });
  useLayoutEffect(() => {
    latest.current = { view, env, draft };
  }, [view, env, draft]);
  const creating = useRef<{ workspace: string; promise: Promise<string | undefined> }>(undefined);

  const report = useCallback((workspace: string | undefined, worktree: boolean) => {
    setEnv((current) =>
      current.workspace === workspace && current.worktree === worktree
        ? current
        : { workspace, worktree },
    );
  }, []);

  // The draft becomes the conversation when the view moves to it; anything else leaves it.
  useEffect(() => {
    if (draft === undefined) return;
    if (view.kind === 'session' && view.id === draft.id) {
      setDraft(undefined);
      return;
    }
    if (view.kind === 'session' || env.workspace !== draft.workspace || env.worktree) {
      discard(api, draft.id);
      setDraft(undefined);
      setPending([]);
    }
  }, [api, view, env, draft]);

  // Preparing tiles belong to the view and folder they were asked in.
  const leftView = view.kind !== 'home' || env.worktree || env.workspace !== opening.workspace;
  useEffect(() => {
    if (leftView && asked.current.ids.length > 0) ask(NOTHING_ASKED);
  }, [ask, leftView]);

  // Tools asked for while the draft opened show once the panels know the draft.
  useEffect(() => {
    if (pending.length === 0 || draft === undefined) return;
    for (const id of pending) togglePanel(id);
    setPending([]);
    // The tools take the preparing tiles' places in the same commit.
    ask({ ...asked.current, ids: asked.current.ids.filter((id) => !pending.includes(id)) });
  }, [ask, pending, draft]);

  const prepare = useCallback((): Promise<string | undefined> => {
    const { view: shown, env: now, draft: ready } = latest.current;
    const workspace = now.workspace;
    if (shown.kind !== 'home' || workspace === undefined || now.worktree) {
      return Promise.resolve(undefined);
    }
    if (ready?.workspace === workspace) return Promise.resolve(ready.id);
    if (creating.current?.workspace === workspace) return creating.current.promise;
    const promise = api
      .createDraftSession(workspace)
      .then((text) => {
        const id = sessionIdOf(text);
        if (id === undefined) throw new Error('Core did not return a session id');
        const after = latest.current;
        if (after.view.kind !== 'home' || after.env.workspace !== workspace || after.env.worktree) {
          // The view moved on while the draft opened.
          discard(api, id);
          return undefined;
        }
        setDraft({ workspace, id });
        return id;
      })
      .finally(() => {
        creating.current = undefined;
      });
    creating.current = { workspace, promise };
    return promise;
  }, [api]);

  const open = useCallback(
    (id: string) => {
      const { env: now, draft: ready } = latest.current;
      if (ready !== undefined && ready.workspace === now.workspace) {
        togglePanel(id);
        return;
      }
      const before = asked.current;
      if (before.workspace !== now.workspace) ask({ workspace: now.workspace, ids: [id] });
      else if (!before.ids.includes(id)) ask({ ...before, ids: [...before.ids, id] });
      prepare().then(
        (opened) => {
          // A tile closed while preparing stays closed.
          if (!asked.current.ids.includes(id)) return;
          if (opened !== undefined) setPending((ids) => (ids.includes(id) ? ids : [...ids, id]));
          else ask(without(id));
        },
        (error: unknown) => {
          ask(without(id));
          console.error('[home] cannot open a draft session for the tools', error);
        },
      );
    },
    [prepare, ask, without],
  );

  const cancel = useCallback(
    (id: string) => {
      ask(without(id));
    },
    [ask, without],
  );

  const home = view.kind === 'home';
  const usable = home && env.workspace !== undefined && !env.worktree;
  const sessionId = home && draft?.workspace === env.workspace ? draft?.id : undefined;
  const shownOpening =
    usable && sessionId === undefined && opening.workspace === env.workspace ? opening.ids : NONE;
  return useMemo(
    () => ({
      sessionId,
      prepare: usable ? prepare : undefined,
      open: usable ? open : undefined,
      opening: shownOpening,
      cancel,
      waiting: home && env.workspace !== undefined && env.worktree,
      report,
    }),
    [sessionId, usable, prepare, open, shownOpening, cancel, home, env, report],
  );
}
