// T37: one session's skills without a live session: the system prompt sections, index and
// style changes as reminders, `paths` skills made available by a touched file, and loads.
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SkillInfo, SkillsCatalog } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import type { CoreBridge } from '../../runtime/core-bridge.js';
import { SKILL_ENTRY } from '../reinjection.js';
import { Reminders } from '../reminders.js';
import { SessionSkills, SKILL_INDEX_DESCRIPTION_CHARS } from './session-skills.js';

function skill(name: string, extra: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name,
    description: `Use ${name}`,
    source: 'projectClaude',
    path: `/w/.claude/skills/${name}/SKILL.md`,
    dir: `/w/.claude/skills/${name}`,
    modelInvocable: true,
    userInvocable: true,
    ...extra,
  };
}

function catalog(skills: SkillInfo[], style = 'Default', instructions?: string): SkillsCatalog {
  return {
    skills,
    commands: [],
    outputStyles: [
      { name: 'Default', source: 'builtIn' },
      { name: 'Concise', source: 'builtIn' },
      {
        name: 'teacher',
        source: 'projectClaude',
        ...(instructions === undefined ? {} : { instructions }),
      },
    ],
    outputStyle: { name: style },
  };
}

/** A bridge answering `skills/*` from the test's current state. */
function fakeBridge(state: {
  catalog: SkillsCatalog;
  matched?: string[];
  content?: string;
  calls: [string, unknown][];
}): CoreBridge {
  const bridge = {
    requestTyped: (method: string, params: unknown, parse: (value: unknown) => unknown) => {
      state.calls.push([method, params]);
      const answer =
        method === 'skills/list'
          ? state.catalog
          : method === 'skills/match'
            ? { matched: state.matched ?? [] }
            : {
                name: 'fix',
                content: state.content ?? 'Fix 42.',
                dir: '/w/.claude/skills/fix',
                allowedTools: ['Bash(git *)'],
              };
      return Promise.resolve(parse(answer));
    },
  };
  return bridge as unknown as CoreBridge;
}

function setup(state: Parameters<typeof fakeBridge>[0]) {
  const manager = SessionManager.inMemory('/w');
  const reminders = new Reminders();
  const skills = new SessionSkills({
    sessionId: 's1',
    manager,
    bridge: fakeBridge(state),
    reminders,
    canonical: (tool) => tool,
    cwd: '/w',
    log: () => undefined,
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  void skills.extension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const run = async (): Promise<string | undefined> => {
    await handlers.get('before_agent_start')?.({}, {});
    return reminders.take()?.content;
  };
  const touch = async (path: string): Promise<void> => {
    await handlers.get('tool_result')?.(
      { toolName: 'Read', isError: false, input: { path }, toolCallId: 'r' },
      {},
    );
  };
  return { manager, reminders, skills, run, touch };
}

describe('SessionSkills', () => {
  it('puts the model-invocable index and the style into the system prompt (T37-A02)', async () => {
    const long = 'x'.repeat(SKILL_INDEX_DESCRIPTION_CHARS + 50);
    const state = {
      calls: [],
      catalog: catalog(
        [
          skill('fix', { description: 'Fix an issue\nwhen asked' }),
          skill('manual', { modelInvocable: false }),
          skill('terse', { visibility: 'nameOnly' }),
          skill('long', { description: long }),
          skill('rust', { paths: ['src/**/*.rs'] }),
        ],
        'Concise',
      ),
    };
    const { skills } = setup(state);
    const sections = await skills.sections();
    expect(sections.skills).toContain('- fix: Fix an issue when asked');
    expect(sections.skills).toContain('- terse\n');
    expect(sections.skills).not.toContain('manual');
    expect(sections.skills).not.toContain('rust');
    const longLine = sections.skills?.split('\n').find((l) => l.startsWith('- long:'));
    expect(longLine?.length).toBe('- long: '.length + SKILL_INDEX_DESCRIPTION_CHARS);
    expect(sections.style).toMatch(/^Output style: Concise\n/);
    expect(skills.modelSkills).toBe(true);
  });

  it('tells the model about index and style changes in reminders (T37-A11)', async () => {
    const state = { calls: [], catalog: catalog([skill('fix')]) };
    const { skills, run } = setup(state);
    await skills.sections();
    expect(await run()).toBeUndefined();
    state.catalog = catalog([skill('fix'), skill('deploy')], 'teacher', 'Explain each step.');
    skills.invalidate();
    const text = await run();
    expect(text).toContain(
      'These skills can now be loaded with the Skill tool:\n- deploy: Use deploy',
    );
    expect(text).toContain('The user switched the output style to "teacher"');
    expect(text).toContain('Explain each step.');
    // Nothing new: nothing again.
    skills.invalidate();
    expect(await run()).toBeUndefined();
    state.catalog = catalog([skill('deploy')]);
    skills.invalidate();
    const back = await run();
    expect(back).toContain('These skills are no longer available: fix.');
    expect(back).toContain('switched the output style back to the default');
  });

  it('makes a paths skill available once a matching file is touched (T37-A06)', async () => {
    const state = {
      calls: [] as [string, unknown][],
      catalog: catalog([skill('rust', { paths: ['src/**/*.rs'] })]),
      matched: ['rust'],
    };
    const { skills, reminders, touch } = setup(state);
    const sections = await skills.sections();
    expect(sections.skills).toBeUndefined();
    await touch('src/lib.rs');
    expect(state.calls).toContainEqual([
      'skills/match',
      { sessionId: 's1', files: ['/w/src/lib.rs'], skills: ['rust'] },
    ]);
    expect(reminders.take()?.content).toContain('- rust: Use rust');
    // Once available, no more matching.
    await touch('src/main.rs');
    expect(state.calls.filter(([m]) => m === 'skills/match')).toHaveLength(1);
  });

  it('records loads for the compaction and answers a repeated load briefly', async () => {
    const state = { calls: [], catalog: catalog([skill('fix')]) };
    const { skills, manager } = setup(state);
    const first = await skills.load('c1', 'fix', '42');
    expect(first.text).toContain('Fix 42.');
    expect(first.text).toContain('Until this turn ends, these need no approval: Bash(git *).');
    const again = await skills.load('c2', 'fix', '42');
    expect(again.text).toContain('already loaded');
    const entries = manager
      .getBranch()
      .filter((e) => e.type === 'custom' && e.customType === SKILL_ENTRY);
    expect(entries).toHaveLength(1);
    skills.invokedByUser(
      { name: 'fix', kind: 'skill', source: 'projectClaude', input: '/fix 7' },
      'Fix 7.',
    );
    skills.invokedByUser(
      { name: 'note', kind: 'command', source: 'projectClaude', input: '/note' },
      'A note.',
    );
    expect(
      manager.getBranch().filter((e) => e.type === 'custom' && e.customType === SKILL_ENTRY),
    ).toHaveLength(2);
  });
});
