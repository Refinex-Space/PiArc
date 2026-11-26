// B5.4: a host with sign-ins imported from Chrome is sensitive like a private address: the
// gate tells Core so (no "always", every mode asks), for the site and its subdomains.
import { describe, expect, it } from 'vitest';

import { AgentGate, type GateDeps, type GatedPage, type GateRun } from './agent-gate.js';
import { importedHost } from './chrome-import.js';

const AGENT: GatedPage = { sessionId: 's', space: 'agent-1', agentControlled: true };

function gate(imported: (sessionId: string, host: string) => Promise<boolean>) {
  const asked: Record<string, unknown>[] = [];
  const run: GateRun = {
    callSessionId: 's',
    toolCallId: 'call-1',
    allowedHosts: new Set(),
    blockedHosts: new Set(),
  };
  const deps: GateDeps = {
    pageOf: (id) => (id === 1 ? AGENT : undefined),
    agentPagesOn: () => [],
    runFor: () => run,
    allowedPorts: () => new Set(),
    askCore: (json) => {
      asked.push(JSON.parse(json) as Record<string, unknown>);
      return Promise.resolve('{"allowed":false}');
    },
    localNames: () => ['*.test'],
    importedHost: imported,
  };
  return { gate: new AgentGate(deps), asked };
}

const navigation = (url: string) => ({
  url,
  resourceType: 'mainFrame',
  webContentsId: 1,
  referrer: '',
});

describe('imported sites are sensitive', () => {
  it('THR-17 marks the imported site and its subdomains sensitive, not other sites', async () => {
    const seen: string[] = [];
    const { gate: g, asked } = gate((sessionId, host) => {
      seen.push(`${sessionId} ${host}`);
      return Promise.resolve(importedHost(host, ['github.com']));
    });
    await g.check(navigation('https://github.com/login'));
    await g.check(navigation('https://API.github.com/user'));
    await g.check(navigation('https://notgithub.com/'));
    expect(asked.map((a) => [a.host, a.sensitive])).toEqual([
      ['github.com', true],
      ['api.github.com', true],
      ['notgithub.com', undefined],
    ]);
    expect(seen).toEqual(['s github.com', 's api.github.com', 's notgithub.com']);
  });

  it('THR-17 counts a host as imported when the records cannot be read', async () => {
    const { gate: g, asked } = gate(() => Promise.reject(new Error('Core is gone')));
    await g.check(navigation('https://example.com/'));
    expect(asked[0]?.sensitive).toBe(true);
  });

  it('keeps private addresses sensitive without imports', async () => {
    const { gate: g, asked } = gate(() => Promise.resolve(false));
    await g.check(navigation('http://192.168.1.20/'));
    expect(asked[0]?.sensitive).toBe(true);
  });
});
