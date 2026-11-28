import { describe, expect, it, vi } from 'vitest';

const showMessageBox = vi.fn<(options: { message: string }) => Promise<{ response: number }>>();
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: (options: { message: string }) => showMessageBox(options) },
}));

const { registerSandboxHandlers, sandboxChange } = await import('./sandbox-ipc.js');
const { IPC_CHANNELS } = await import('../../shared/ipc.js');

describe('sandboxChange', () => {
  it('keeps the known fields of their types (T39)', () => {
    expect(
      sandboxChange({
        enabled: true,
        autoAllow: false,
        allowedDomains: ['a.example'],
        denyRead: [],
      }),
    ).toEqual({ enabled: true, autoAllow: false, allowedDomains: ['a.example'], denyRead: [] });
  });

  it('refuses unknown fields, wrong types and multi-line entries', () => {
    expect(() => sandboxChange({ excludedCommands: [] })).toThrow('unknown sandbox setting');
    expect(() => sandboxChange({ enabled: 'yes' })).toThrow('enabled must be a boolean');
    expect(() => sandboxChange({ allowedDomains: ['a\nb'] })).toThrow('one-line');
    expect(() => sandboxChange({ denyRead: 'x' })).toThrow('list');
  });
});

describe('the sandbox page loosening the sandbox (R5)', () => {
  type Handler = (event: { sender: unknown }, args: unknown[]) => Promise<unknown>;

  function setup(view: unknown) {
    const handlers = new Map<string, Handler>();
    const saved: string[] = [];
    const core = {
      sandboxSettings: () => Promise.resolve(JSON.stringify(view)),
      setSandboxSettings: (_dir: string | null, change: string) => {
        saved.push(change);
        return Promise.resolve('{"status":"saved"}');
      },
    };
    registerSandboxHandlers(
      ((channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      }) as never,
      core,
      () => ({ t: (id: string) => id }) as never,
    );
    const update = (change: unknown) =>
      handlers.get(IPC_CHANNELS.sandboxUpdate)?.({ sender: {} }, [null, change]);
    return { update, saved };
  }

  const view = { user: { enabled: true, allowedDomains: [], denyRead: ['~/.ssh', '~/.aws'] } };

  it('asks before turning the sandbox off or dropping read protections', async () => {
    for (const change of [{ enabled: false }, { denyRead: ['~/.aws'] }]) {
      showMessageBox.mockReset();
      showMessageBox.mockResolvedValue({ response: 1 });
      const { update, saved } = setup(view);
      expect(await update(change)).toBe('{"status":"cancelled"}');
      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(saved).toEqual([]);
    }
  });

  it('saves tightening changes without asking', async () => {
    showMessageBox.mockReset();
    const { update, saved } = setup(view);
    await update({ enabled: true, denyRead: ['~/.ssh', '~/.aws', '~/.gnupg'] });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
  });
});
