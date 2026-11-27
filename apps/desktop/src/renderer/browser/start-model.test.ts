import type { DevServerState } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { markPreview, previewMarked, showPreview } from './attention.js';
import {
  failureKey,
  failures,
  issuePlace,
  parseStartPage,
  parseSuggestions,
  running,
  serverRows,
  serviceRows,
} from './start-model.js';
import { nextSelection } from './suggest.js';

const ready: DevServerState = {
  name: 'web',
  status: 'ready',
  startedBy: 'user',
  port: 5173,
  url: 'http://localhost:5173/',
  taskId: 'bg-000000000001',
};
const failed: DevServerState = {
  name: 'api',
  status: 'failed',
  startedBy: 'agent',
  port: 4000,
  url: 'http://localhost:4000/',
  taskId: 'bg-000000000002',
  failure: 'exited',
  exitCode: 1,
  log: ['Error: listen EADDRINUSE'],
};

describe('the start page data', () => {
  it('keeps what is well formed', () => {
    expect(
      parseStartPage({
        recents: [{ url: 'https://a.test/', title: 'A' }, { url: 3 }],
        launch: {
          configs: [
            {
              name: 'web',
              source: 'piarc',
              command: 'npm run dev',
              cwd: '/w',
              port: 5173,
              url: 'http://localhost:5173/',
              fingerprint: 'f',
            },
            { name: 'broken' },
          ],
          autoVerify: true,
          trusted: false,
          issues: [{ file: '.claude/launch.json', line: 2, column: 9, message: 'bad' }],
        },
      }),
    ).toMatchObject({
      recents: [{ url: 'https://a.test/', title: 'A' }],
      launch: { trusted: false, configs: [{ name: 'web' }], issues: [{ line: 2 }] },
    });
    expect(parseStartPage(null)).toEqual({ recents: [] });
    expect(parseStartPage({ recents: [], launch: { trusted: 'no' } })).toEqual({ recents: [] });
  });

  it('reads suggestions and places issues', () => {
    expect(
      parseSuggestions([
        { url: 'https://a.test/', title: 'A', kind: 'tab' },
        { url: 'https://b.test/', title: 'B', kind: 'bookmark' },
      ]),
    ).toEqual([{ url: 'https://a.test/', title: 'A', kind: 'tab' }]);
    expect(issuePlace({ file: '.piarc/launch.json', line: 3, column: 7, message: 'x' })).toBe(
      '.piarc/launch.json:3:7',
    );
    expect(issuePlace({ file: '.piarc/launch.json', message: 'x' })).toBe('.piarc/launch.json');
  });

  it('lists ready servers, then other listening ports, once per port', () => {
    const services = {
      ports: [
        { port: 5173, taskId: 'bg-000000000001', kind: 'devServer' as const, title: 'web' },
        { port: 9229, taskId: 'bg-000000000003', kind: 'terminal' as const, title: 'zsh' },
      ],
      servers: [ready, failed],
    };
    expect(serviceRows(services)).toEqual([
      { port: 5173, url: 'http://localhost:5173/', title: 'web' },
      { port: 9229, url: 'http://localhost:9229/', title: 'zsh' },
    ]);
    expect(serviceRows(undefined)).toEqual([]);
    const configs = [
      {
        name: 'web',
        source: 'piarc' as const,
        command: 'npm run dev',
        cwd: '/w',
        port: 5173,
        url: 'http://localhost:5173/',
        fingerprint: 'f',
      },
    ];
    expect(serverRows(configs, services)[0]?.state).toBe(ready);
    expect(running(ready)).toBe(true);
    expect(running(failed)).toBe(false);
    expect(running(undefined)).toBe(false);
  });

  it('reports failures until the user closes them, and a new failure again', () => {
    const services = { ports: [], servers: [ready, failed] };
    expect(failures(services, new Set())).toEqual([failed]);
    expect(failures(services, new Set([failureKey(failed)]))).toEqual([]);
    const again = { ...failed, taskId: 'bg-000000000004' };
    expect(failures({ ports: [], servers: [again] }, new Set([failureKey(failed)]))).toEqual([
      again,
    ]);
  });
});

describe('the address bar list', () => {
  it('moves through the suggestions and wraps around', () => {
    expect(nextSelection(-1, 1, 3)).toBe(0);
    expect(nextSelection(2, 1, 3)).toBe(0);
    expect(nextSelection(-1, -1, 3)).toBe(2);
    expect(nextSelection(0, -1, 3)).toBe(2);
    expect(nextSelection(0, 1, 0)).toBe(-1);
  });
});

describe('the preview button dot', () => {
  it('marks a session until its preview shows, and not while it shows', () => {
    markPreview('s1');
    expect(previewMarked('s1')).toBe(true);
    const hide = showPreview('s1');
    expect(previewMarked('s1')).toBe(false);
    markPreview('s1');
    expect(previewMarked('s1')).toBe(false);
    hide();
    markPreview('s1');
    expect(previewMarked('s1')).toBe(true);
    expect(previewMarked('s2')).toBe(false);
  });
});
