// A window's history holds destinations only. Drafts and one-shot errors belong to the page.
import { useCallback, useState } from 'react';
import type { View } from './ui.js';

interface History {
  readonly current: View;
  readonly back: View[];
  readonly forward: View[];
}

function destination(view: View): View {
  return view.kind === 'session' ? view : { kind: 'home', workspace: view.workspace };
}

function samePlace(a: View, b: View): boolean {
  return a.kind === 'home'
    ? b.kind === 'home' && a.workspace === b.workspace
    : b.kind === 'session' && a.id === b.id;
}

export function useViewHistory(available: (view: View) => boolean) {
  const [history, setHistory] = useState<History>({
    current: { kind: 'home', workspace: undefined },
    back: [],
    forward: [],
  });
  const visit = useCallback((next: View | ((view: View) => View)) => {
    setHistory((old) => {
      const current = typeof next === 'function' ? next(old.current) : next;
      if (samePlace(old.current, current)) return { ...old, current };
      return { current, back: [...old.back.slice(-49), destination(old.current)], forward: [] };
    });
  }, []);
  const travel = (direction: 'back' | 'forward') => {
    if (!history[direction].some(available)) return undefined;
    return () => {
      setHistory((old) => {
        const stack = old[direction];
        const index = stack.findLastIndex(available);
        const next = stack[index];
        if (next === undefined) return old;
        const visited = destination(old.current);
        return direction === 'back'
          ? { current: next, back: stack.slice(0, index), forward: [...old.forward, visited] }
          : { current: next, back: [...old.back, visited], forward: stack.slice(0, index) };
      });
    };
  };
  return { view: history.current, visit, back: travel('back'), forward: travel('forward') };
}
