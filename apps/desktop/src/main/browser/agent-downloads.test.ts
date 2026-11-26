import { EventEmitter } from 'node:events';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { HostRun as Run } from './host-bindings.js';

vi.mock('electron', () => ({}));

const { AgentDownloads, DOWNLOAD_LIMITS, freePath, safeName, spaceNumber } =
  await import('./agent-downloads.js');

class FakeItem extends EventEmitter {
  savePath = '';
  cancelled = false;
  received = 0;
  total = 10;
  getFilename = () => '../report?.pdf';
  getURL = () => 'http://localhost:5173/report.pdf';
  getReceivedBytes = () => this.received;
  getTotalBytes = () => this.total;
  setSavePath = (file: string) => {
    this.savePath = file;
  };
  cancel = () => {
    this.cancelled = true;
  };
}

function fixture(controlled = true, running = true) {
  const emitted: { targetId: string; method: string; params: Record<string, unknown> }[] = [];
  const run = {
    callSessionId: 'child',
    downloads: new Map(),
    proxies: new Map([
      [
        3,
        {
          emitPage: (targetId: string, method: string, params: Record<string, unknown>) =>
            emitted.push({ targetId, method, params }),
        },
      ],
    ]),
  } as unknown as Run;
  const downloads = new AgentDownloads({
    pageOf: () => ({ sessionId: 'main', space: 'agent-3', agentControlled: controlled }),
    runFor: () => (running ? run : undefined),
    directory: () => path.join('/data', 'sessions', 'child', 'tmp', 'browser', 'downloads'),
    targetIdOf: () => Promise.resolve('T1'),
  });
  return { downloads, run, emitted };
}

const contents = { id: 7 } as unknown as Electron.WebContents;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('agent downloads (B2.6.6)', () => {
  it('finds a free name in a download folder (B1.3.6)', () => {
    const dir = path.join('/Users', 'me', 'Downloads');
    const taken = new Set([path.join(dir, 'a.pdf'), path.join(dir, 'a (1).pdf')]);
    const exists = (file: string) => taken.has(file);
    expect(freePath(dir, 'a.pdf', exists)).toBe(path.join(dir, 'a (2).pdf'));
    expect(freePath(dir, 'b.tar.gz', exists)).toBe(path.join(dir, 'b.tar.gz'));
    expect(freePath(dir, '../x', exists)).toBe(path.join(dir, '_x'));
  });

  it('names files safely and reads Space numbers', () => {
    expect(safeName('../a/b?.pdf')).toBe('_a_b_.pdf');
    expect(safeName('...')).toBe('download');
    expect(spaceNumber('agent-12')).toBe(12);
    expect(spaceNumber('user')).toBeUndefined();
  });

  it('saves a running call download to the session and reports it to the SDK', async () => {
    const f = fixture();
    const item = new FakeItem();
    expect(f.downloads.take(contents, item as unknown as Electron.DownloadItem)).toBe(true);
    expect(item.savePath).toMatch(/downloads[\\/][0-9a-f-]{36}-_report_\.pdf$/u);
    await flush();
    expect(f.emitted[0]).toMatchObject({
      targetId: 'T1',
      method: 'Page.downloadWillBegin',
      params: { suggestedFilename: '_report_.pdf', url: 'http://localhost:5173/report.pdf' },
    });
    item.received = 10;
    item.emit('done', {}, 'completed');
    await flush();
    expect(f.emitted.at(-1)).toMatchObject({
      method: 'Page.downloadProgress',
      params: { state: 'completed', filePath: item.savePath },
    });
    expect([...f.run.downloads.values()][0]?.state).toBe('completed');
  });

  it('leaves the user pages and pages without a call alone', () => {
    expect(fixture(false).downloads.take(contents, new FakeItem() as never)).toBe(false);
    expect(fixture(true, false).downloads.take(contents, new FakeItem() as never)).toBe(false);
  });

  it('cancels beyond the size and count limits', () => {
    const f = fixture();
    const big = new FakeItem();
    f.downloads.take(contents, big as never);
    big.total = DOWNLOAD_LIMITS.bytes + 1;
    big.emit('updated');
    expect(big.cancelled).toBe(true);
    for (let i = f.run.downloads.size; i < DOWNLOAD_LIMITS.count; i += 1) {
      f.downloads.take(contents, new FakeItem() as never);
    }
    const extra = new FakeItem();
    expect(f.downloads.take(contents, extra as never)).toBe(true);
    expect(extra.cancelled).toBe(true);
  });
});
