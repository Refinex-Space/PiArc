import { describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  visible: boolean;
  minimized: boolean;
}
let window: FakeWindow | null = { visible: true, minimized: false };
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () =>
      window === null
        ? null
        : {
            isVisible: () => window?.visible === true,
            isMinimized: () => window?.minimized === true,
            on: () => undefined,
          },
    getAllWindows: () => [],
  },
  powerMonitor: { on: () => undefined },
  shell: { openExternal: () => Promise.resolve() },
  systemPreferences: {},
}));

const {
  mayObserveDictation,
  microphoneSettingsUrl,
  modelAction,
  registerDictationHandlers,
  startRequest,
} = await import('./dictation-ipc.js');
const { IPC_CHANNELS } = await import('../../shared/ipc.js');
const { decodeIpcError } = await import('../../shared/ipc-error.js');

type Handler = (event: { sender: unknown }, args: unknown[]) => unknown;

describe('the dictation route', () => {
  it('THR-18 lets only the starting window observe its dictation', () => {
    expect(mayObserveDictation(7, 'dictation/7')).toBe(true);
    expect(mayObserveDictation(8, 'dictation/7')).toBe(false);
    expect(mayObserveDictation(7, 'dictation/7/x')).toBe(false);
    expect(mayObserveDictation(7, 'dictation/')).toBe(false);
    expect(mayObserveDictation(7, 'core/speech')).toBe(true);
    expect(mayObserveDictation(7, 'core/sessions')).toBe(true);
  });
});

describe('startRequest', () => {
  it('keeps the known members and refuses the rest', () => {
    expect(startRequest({ composer: 'session:abc', extra: 1 })).toEqual({
      composer: 'session:abc',
      test: false,
    });
    expect(startRequest({ composer: 'workspace:/w', workspace: '/w', test: true })).toEqual({
      composer: 'workspace:/w',
      workspace: '/w',
      test: true,
    });
    expect(startRequest({ composer: 'workspace:C:\\w', workspace: 'C:\\w' }).workspace).toBe(
      'C:\\w',
    );
    for (const bad of [
      null,
      [],
      'session:x',
      { composer: '' },
      { composer: 'other:x' },
      { composer: 'session:a\nb' },
      { composer: 'session:\u202ex' },
      { composer: 'session:x', workspace: 'relative' },
      { composer: 'session:x', workspace: 3 },
      { composer: 'session:x', test: 'yes' },
      { composer: `session:${'x'.repeat(5000)}` },
    ]) {
      expect(() => startRequest(bad)).toThrow(TypeError);
    }
  });
});

describe('modelAction', () => {
  it('accepts the known models and actions only', () => {
    expect(modelAction('qwen3-asr-0.6b-int8', 'download')).toEqual([
      'qwen3-asr-0.6b-int8',
      'download',
    ]);
    expect(() => modelAction('../evil', 'download')).toThrow(TypeError);
    expect(() => modelAction('qwen3-asr-0.6b-int8', 'install')).toThrow(TypeError);
  });
});

describe('microphoneSettingsUrl', () => {
  it('is a fixed system page per platform', () => {
    expect(microphoneSettingsUrl('darwin')).toContain('Privacy_Microphone');
    expect(microphoneSettingsUrl('win32')).toBe('ms-settings:privacy-microphone');
    expect(microphoneSettingsUrl('linux')).toBeUndefined();
  });
});

describe('the dictation commands', () => {
  function setup(options: {
    microphone: 'granted' | 'denied' | 'not-determined';
    grant?: boolean;
    input?: boolean;
    confirm?: boolean;
  }) {
    const handlers = new Map<string, Handler>();
    const started: string[] = [];
    const actions: string[] = [];
    let requests = 0;
    let state = options.microphone;
    const core = {
      dictationStart: (json: string) => {
        started.push(json);
        return Promise.resolve('{"sessionId":"dictation-1","route":"dictation/5"}');
      },
      dictationStop: vi.fn(),
      dictationCancel: vi.fn(),
      dictationRelease: vi.fn(),
      dictationStatus: () => '{"sessionId":"dictation-1","windowId":5,"test":false}',
      speechDevices: () => Promise.resolve('[]'),
      speechModels: () => Promise.resolve('{"models":[]}'),
      speechModelAction: (id: string, action: string) => {
        actions.push(`${id} ${action}`);
        return Promise.resolve('{"models":[]}');
      },
    };
    const asked: string[] = [];
    registerDictationHandlers(
      ((channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      }) as never,
      core,
      {
        requireInput: () => {
          if (options.input === false) throw new Error('no input');
        },
      },
      () => ({
        status: () => state,
        request: () => {
          requests += 1;
          if (state === 'not-determined') state = options.grant === true ? 'granted' : 'denied';
          return Promise.resolve(state === 'granted');
        },
      }),
      {
        ask: (_window: unknown, text: { message: string }) => {
          asked.push(text.message);
          return Promise.resolve(options.confirm === true);
        },
      } as never,
      () => ({ t: (id: string) => id }) as never,
    );
    const sender = { id: 5, once: () => undefined, on: () => undefined };
    const call = (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({ sender }, args));
    return { call, started, actions, asked, requests: () => requests, core };
  }

  async function code(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      return decodeIpcError(error.message)?.message;
    }
    return undefined;
  }

  it('THR-18 takes the window id from the sender, never from the page', async () => {
    window = { visible: true, minimized: false };
    const s = setup({ microphone: 'granted' });
    await s.call(IPC_CHANNELS.dictationStart, { composer: 'session:a', windowId: 99 });
    expect(JSON.parse(s.started[0] ?? '')).toEqual({
      composer: 'session:a',
      test: false,
      windowId: 5,
    });
  });

  it('THR-18 asks for the microphone once and not again after a refusal', async () => {
    window = { visible: true, minimized: false };
    const s = setup({ microphone: 'not-determined', grant: false });
    expect(await code(s.call(IPC_CHANNELS.dictationStart, { composer: 'session:a' }))).toBe(
      'speech:microphoneDenied',
    );
    expect(await code(s.call(IPC_CHANNELS.dictationStart, { composer: 'session:a' }))).toBe(
      'speech:microphoneDenied',
    );
    expect(s.requests()).toBe(1);
    expect(s.started).toEqual([]);
  });

  it('starts after the permission is granted on request', async () => {
    window = { visible: true, minimized: false };
    const s = setup({ microphone: 'not-determined', grant: true });
    await s.call(IPC_CHANNELS.dictationStart, { composer: 'session:a' });
    expect(s.started).toHaveLength(1);
  });

  it('THR-18 needs recent real input and a visible window', async () => {
    window = { visible: true, minimized: false };
    const noInput = setup({ microphone: 'granted', input: false });
    expect(await code(noInput.call(IPC_CHANNELS.dictationStart, { composer: 'session:a' }))).toBe(
      'speech:noRecentInput',
    );
    window = { visible: true, minimized: true };
    const hidden = setup({ microphone: 'granted' });
    expect(await code(hidden.call(IPC_CHANNELS.dictationStart, { composer: 'session:a' }))).toBe(
      'speech:windowHidden',
    );
    expect([...noInput.started, ...hidden.started]).toEqual([]);
  });

  it('checks the session id and mode of stop and cancel', async () => {
    const s = setup({ microphone: 'granted' });
    await s.call(IPC_CHANNELS.dictationStop, 'dictation-1', 'send');
    expect(s.core.dictationStop).toHaveBeenCalledWith(5, 'dictation-1', 'send');
    await expect(s.call(IPC_CHANNELS.dictationStop, 'dictation-1', 'discard')).rejects.toThrow(
      TypeError,
    );
    await expect(s.call(IPC_CHANNELS.dictationCancel, '../x')).rejects.toThrow(TypeError);
  });

  it('answers the status with this window route and whether the dictation is its own', async () => {
    const s = setup({ microphone: 'granted' });
    const status: unknown = JSON.parse(String(await s.call(IPC_CHANNELS.dictationStatus)));
    expect(status).toMatchObject({ route: 'dictation/5', mine: true, microphone: 'granted' });
  });

  it('asks natively before deleting a model and does nothing when cancelled', async () => {
    const cancelled = setup({ microphone: 'granted', confirm: false });
    await cancelled.call(IPC_CHANNELS.speechModelAction, 'qwen3-asr-0.6b-int8', 'delete');
    expect(cancelled.asked).toEqual(['settings.voice.deleteConfirm']);
    expect(cancelled.actions).toEqual([]);
    const confirmed = setup({ microphone: 'granted', confirm: true });
    await confirmed.call(IPC_CHANNELS.speechModelAction, 'qwen3-asr-0.6b-int8', 'delete');
    expect(confirmed.actions).toEqual(['qwen3-asr-0.6b-int8 delete']);
    const verify = setup({ microphone: 'granted' });
    await verify.call(IPC_CHANNELS.speechModelAction, 'x-asr-zh-en-480ms-int8', 'verify');
    expect(verify.asked).toEqual([]);
    expect(verify.actions).toEqual(['x-asr-zh-en-480ms-int8 verify']);
  });

  it('needs real input to start a download', async () => {
    const s = setup({ microphone: 'granted', input: false });
    expect(
      await code(s.call(IPC_CHANNELS.speechModelAction, 'qwen3-asr-0.6b-int8', 'download')),
    ).toBe('speech:noRecentInput');
    expect(s.actions).toEqual([]);
  });
});
