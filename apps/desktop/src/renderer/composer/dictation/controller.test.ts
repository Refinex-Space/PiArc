// The dictation controller with a fake window API (addendum V-2.1, V-3.2, V-3.7, V-4.1–V-4.5).
// @vitest-environment happy-dom
import { history } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { composerSchema } from '../schema.js';
import {
  DictationController,
  SEND_WAIT_MS,
  codeOf,
  type DictationApi,
  type DictationUi,
} from './controller.js';
import { dictationPlugin } from './plugin.js';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

function editor(text = ''): EditorView {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, text === '' ? [] : [composerSchema.text(text)]),
  ]);
  let state = EditorState.create({
    schema: composerSchema,
    doc,
    plugins: [dictationPlugin(), history()],
  });
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const view = new EditorView(document.createElement('div'), { state });
  views.push(view);
  return view;
}

function fakeApi() {
  let listener: ((payload: unknown) => void) | undefined;
  const calls: string[] = [];
  const api: DictationApi = {
    start: (request) => {
      calls.push(`start ${request.composer}`);
      return Promise.resolve({ sessionId: 'dictation-1', route: 'dictation/7' });
    },
    stop: (id, mode) => {
      calls.push(`stop ${id} ${mode}`);
      return Promise.resolve();
    },
    cancel: (id) => {
      calls.push(`cancel ${id}`);
      return Promise.resolve();
    },
    route: () => Promise.resolve('dictation/7'),
    subscribe: (_route, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    now: () => 1000,
  };
  let sequence = 0;
  const emit = (event: Record<string, unknown>, session = 'dictation-1') => {
    sequence += 1;
    const bytes = new TextEncoder().encode(
      JSON.stringify([{ sessionId: session, sequence, ...event }]),
    );
    listener?.(bytes);
  };
  return { api, calls, emit };
}

function controllerFor(view: EditorView, api: DictationApi) {
  const states: DictationUi[] = [];
  const notices: string[] = [];
  const announced: string[] = [];
  const controller = new DictationController(
    () => view,
    api,
    {
      state: (ui) => states.push(ui),
      notice: (code) => notices.push(code),
      announce: (text) => announced.push(text),
    },
    'session:s1',
    () => '/work',
  );
  return { controller, states, notices, announced };
}

describe('dictation controller', () => {
  it('runs a session from start to completed text', async () => {
    const view = editor('前缀 ');
    const { api, calls, emit } = fakeApi();
    const { controller, states, announced } = controllerFor(view, api);
    await controller.start();
    expect(calls).toEqual(['start session:s1']);
    emit({ type: 'state', state: 'recording' });
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'partial', text: '你好' });
    expect(view.state.doc.textContent).toBe('前缀 ');
    emit({ type: 'text', segmentId: 0, revision: 2, stage: 'final', text: '你好。' });
    expect(view.state.doc.textContent).toBe('前缀 你好。');
    controller.stop();
    emit({ type: 'state', state: 'finalizing' });
    emit({ type: 'state', state: 'completed' });
    expect(states.map((s) => s.kind)).toEqual([
      'starting',
      'preparing',
      'recording',
      'finalizing',
      'idle',
    ]);
    expect(calls).toContain('stop dictation-1 keep');
    expect(announced).toEqual(['你好。']);
  });

  it('ignores other sessions, repeats and older events', async () => {
    const view = editor();
    const { api, emit } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'other' }, 'dictation-9');
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'mine' });
    expect(view.state.doc.textContent).toBe('mine');
  });

  it('holds changes while an input method composes', async () => {
    const view = editor();
    const { api, emit } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'later' });
    expect(view.state.doc.textContent).toBe('');
    Object.defineProperty(view, 'composing', { configurable: true, get: () => false });
    view.dom.dispatchEvent(new Event('compositionend'));
    await Promise.resolve();
    expect(view.state.doc.textContent).toBe('later');
  });

  it('sending waits for completion once, however often it is asked', async () => {
    const view = editor();
    const { api, calls, emit } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'state', state: 'recording' });
    const first = controller.stopForSend();
    const second = controller.stopForSend();
    expect(second).toBe(first);
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'last words' });
    emit({ type: 'state', state: 'completed' });
    await expect(first).resolves.toBe(true);
    expect(view.state.doc.textContent).toBe('last words');
    expect(calls.filter((c) => c.startsWith('stop'))).toEqual(['stop dictation-1 send']);
  });

  it('sending gives up after the wait and does not send', async () => {
    vi.useFakeTimers();
    const view = editor();
    const { api, emit } = fakeApi();
    const { controller, states } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'state', state: 'recording' });
    const sent = controller.stopForSend();
    vi.advanceTimersByTime(SEND_WAIT_MS);
    await expect(sent).resolves.toBe(false);
    expect(states.at(-1)).toEqual({ kind: 'error', code: 'sendTimeout' });
  });

  it('sending after the wait with words on screen sends them, the hypothesis included (V-4.3, V-4.5)', async () => {
    vi.useFakeTimers();
    const view = editor();
    const { api, emit, calls } = fakeApi();
    const { controller, states } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'state', state: 'recording' });
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: '第一句。' });
    emit({ type: 'text', segmentId: 1, revision: 1, stage: 'partial', text: '第二' });
    const sent = controller.stopForSend();
    vi.advanceTimersByTime(SEND_WAIT_MS);
    await expect(sent).resolves.toBe(true);
    expect(view.state.doc.textContent).toBe('第一句。第二');
    expect(calls).toContain('cancel dictation-1');
    expect(states.at(-1)).toEqual({ kind: 'idle' });
    // Late results of the abandoned session are not written.
    emit({ type: 'text', segmentId: 1, revision: 2, stage: 'final', text: '第二句。' });
    expect(view.state.doc.textContent).toBe('第一句。第二');
  });

  it('cancelling while the start is on its way ends the session as soon as it answers (V-4.4)', async () => {
    const view = editor('typed');
    const { api, calls, emit } = fakeApi();
    let answer: (() => void) | undefined;
    const started = api.start;
    api.start = (request) =>
      new Promise((resolve) => {
        answer = () => {
          resolve(started(request));
        };
      });
    const { controller, states } = controllerFor(view, api);
    const starting = controller.start();
    // The start request is out (the main process may be asking for the microphone).
    await vi.waitFor(() => {
      expect(answer).toBeDefined();
    });
    expect(controller.ui.kind).toBe('starting');
    await expect(controller.stopForSend()).resolves.toBe(true);
    answer?.();
    await starting;
    expect(calls).toContain('cancel dictation-1');
    expect(states.at(-1)).toEqual({ kind: 'idle' });
    emit({ type: 'state', state: 'recording' });
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: '迟到' });
    expect(view.state.doc.textContent).toBe('typed');
    expect(controller.ui.kind).toBe('idle');
  });

  it('a replaced document ends the session without moving the hypothesis (V-3.5)', async () => {
    const view = editor();
    const { api, calls, emit } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'state', state: 'recording' });
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'partial', text: '一半' });
    controller.abandon();
    view.dispatch(view.state.tr.insertText('given back', 1, view.state.doc.content.size - 1));
    emit({ type: 'text', segmentId: 0, revision: 2, stage: 'final', text: '一半的话。' });
    expect(view.state.doc.textContent).toBe('given back');
    expect(calls).toContain('cancel dictation-1');
    expect(controller.ui.kind).toBe('idle');
  });

  it('sending while preparing cancels and sends at once', async () => {
    const view = editor('typed');
    const { api, calls } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    await expect(controller.stopForSend()).resolves.toBe(true);
    expect(calls).toContain('cancel dictation-1');
  });

  it('an error ends with its code and keeps confirmed text', async () => {
    const view = editor();
    const { api, emit } = fakeApi();
    const { controller, states } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'kept' });
    emit({ type: 'state', state: 'error', code: 'deviceLost' });
    expect(view.state.doc.textContent).toBe('kept');
    expect(states.at(-1)).toEqual({ kind: 'error', code: 'deviceLost' });
  });

  it('a refused start shows its code', async () => {
    const view = editor();
    const { api } = fakeApi();
    api.start = () => Promise.reject(new Error('[piarc:permissionDenied] speech:microphoneDenied'));
    const { controller, states } = controllerFor(view, api);
    await controller.start();
    expect(states.at(-1)).toEqual({ kind: 'error', code: 'microphoneDenied' });
    expect(codeOf(new Error('nothing'))).toBe('unknown');
  });

  it('detaching turns the hypothesis into text and cancels the session', async () => {
    const view = editor();
    const { api, calls, emit } = fakeApi();
    const { controller } = controllerFor(view, api);
    await controller.start();
    emit({ type: 'text', segmentId: 0, revision: 1, stage: 'partial', text: 'unfinished' });
    controller.detach();
    expect(view.state.doc.textContent).toBe('unfinished');
    expect(calls).toContain('cancel dictation-1');
  });

  it('events that come before the start answer are kept', async () => {
    const view = editor();
    const { api, emit } = fakeApi();
    const started = api.start;
    api.start = async (request) => {
      emit({ type: 'state', state: 'recording' });
      emit({ type: 'text', segmentId: 0, revision: 1, stage: 'final', text: 'fast' });
      return started(request);
    };
    const { controller } = controllerFor(view, api);
    await controller.start();
    expect(view.state.doc.textContent).toBe('fast');
    expect(controller.ui.kind).toBe('recording');
  });
});
