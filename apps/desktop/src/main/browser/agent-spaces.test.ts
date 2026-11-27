// Space control (design addendum B2.5): who may give a Space back to the agent.
import { describe, expect, it } from 'vitest';

import { agentHolds, AgentSpaces, SpaceError, type SpaceCaller } from './agent-spaces.js';
import type { AgentModel, Space } from './service.js';
import type { BrowserTab } from './tab.js';

function fixture() {
  const spaces: Space[] = [
    { id: 'user', name: 'My tabs', kind: 'user', ownership: 'user', running: false },
  ];
  const tabs: BrowserTab[] = [];
  const model = {
    sessionId: 's',
    workspace: '/w',
    partition: 'p',
    spaces,
    tabs,
    active: () => undefined,
    newTab: (space: string, url: string) => {
      const openedBy = space === 'user' ? 'user' : 'agent';
      const tab = {
        id: `t${String(tabs.length + 1)}`,
        space,
        url,
        title: '',
        openedBy,
      } as BrowserTab;
      tabs.push(tab);
      return tab;
    },
    closeTab: () => undefined,
    select: () => undefined,
    contents: () => ({}),
    changed: () => undefined,
    watch: () => () => undefined,
  } as unknown as AgentModel;
  const spacesOf = new AgentSpaces({
    model: () => Promise.resolve(model),
    handedOff: () => undefined,
  });
  const caller = (): SpaceCaller => ({ sessionId: 's', touched: new Set() });
  return { spaces: spacesOf, model, caller };
}

async function refusal(promise: Promise<unknown>): Promise<SpaceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SpaceError) return error;
    throw error;
  }
  throw new Error('expected a SpaceError');
}

describe('taking a Space back (B2.5.2, B2.5.3)', () => {
  it('leaves a Space the user took over with the user until they hand it back', async () => {
    const { spaces, model, caller } = fixture();
    const { id } = await spaces.create(caller(), 'checkout');
    await spaces.userTakeOver('s', 'agent-1');
    const error = await refusal(spaces.takeOver(caller(), id));
    expect(error.code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    expect(error.reason).toBe('manual_takeover');
    expect(model.spaces.find((s) => s.id === 'agent-1')?.ownership).toBe('agentDelegatedToUser');

    expect(await spaces.userHandBack('s', 'agent-1')).toBe(false);
    expect(model.spaces.find((s) => s.id === 'agent-1')?.ownership).toBe('agent');
  });

  it('lets the agent resume a Space it handed off', async () => {
    const { spaces, model, caller } = fixture();
    const { id } = await spaces.create(caller(), 'login');
    await spaces.handOff(caller(), id, 'Sign in please');
    const error = await refusal(spaces.setState(caller(), id, 'typing'));
    expect(error.reason).toBe('handoff');
    await spaces.takeOver(caller(), id);
    const space = model.spaces.find((s) => s.id === 'agent-1');
    expect(space?.ownership).toBe('agent');
    expect(space?.handOff).toBeUndefined();
  });
});

describe('agentHolds (B1.3.2)', () => {
  it('is true for an agent Space the agent controls, running or between calls', () => {
    expect(agentHolds({ kind: 'agent', ownership: 'agent' })).toBe(true);
    expect(agentHolds({ kind: 'agent', ownership: 'agentDelegatedToUser' })).toBe(false);
    expect(agentHolds({ kind: 'agent', ownership: 'user' })).toBe(false);
    expect(agentHolds({ kind: 'user', ownership: 'user' })).toBe(false);
    expect(agentHolds(undefined)).toBe(false);
  });
});

describe('sharing a tab with the agent (B2.3.4)', () => {
  it('moves the user’s tab into a Space the agent can claim, keeping it the user’s', async () => {
    const { spaces, model, caller } = fixture();
    const own = model.newTab('user', 'https://example.com/report');
    (own as { title: string }).title = 'Quarterly report';
    expect((await spaces.list(caller())).map((s) => s.name)).toEqual(['My tabs (1)']);

    const shared = await spaces.share('s', own.id);
    expect(shared).toBeDefined();
    expect(own.space).not.toBe('user');
    expect(own.openedBy).toBe('user');
    const listed = (await spaces.list(caller())).find((s) => s.id === shared);
    expect(listed).toMatchObject({
      name: 'Shared: Quarterly report',
      ownership: 'user',
      createdBy: 'user',
      recentTabTitles: ['Quarterly report'],
    });
    // The agent claims it before it works in it, as with a Space it finished.
    await refusal(spaces.setState(caller(), shared ?? 0, 'reading'));
    await spaces.claim(caller(), shared ?? 0);
    expect(model.spaces.find((s) => s.id === own.space)?.ownership).toBe('agent');
  });

  it('shares only the user’s own tabs, within the Space limit', async () => {
    const { spaces, model, caller } = fixture();
    await spaces.create(caller(), 'work');
    const agentTab = model.tabs[0];
    expect(await spaces.share('s', agentTab?.id ?? '')).toBeUndefined();
    for (const name of ['b', 'c', 'd']) await spaces.create(caller(), name);
    const own = model.newTab('user', 'https://example.com/');
    const error = await refusal(spaces.share('s', own.id));
    expect(error.code).toBe('PIARC_LIMIT');
    expect(own.space).toBe('user');
  });
});
