import { describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE } from '../../tools/profile.js';
import { createAgentTool } from './agent-tool.js';
import { BUILT_IN_TYPES, catalogOf, parseCoreAgents, startable } from './definitions.js';
import { allowedTools } from './tool-filter.js';

const parent = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'SuggestNextSteps',
  'Agent',
  'mcp__docs__search',
];

describe('allowedTools', () => {
  it('keeps the parent tools minus the ones that talk to the user, and Agent below the limit', () => {
    expect([...allowedTools(parent, {}, 1, 3)]).toEqual([
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'WebFetch',
      'TodoWrite',
      'Agent',
      'mcp__docs__search',
    ]);
    expect(allowedTools(parent, {}, 3, 3).has('Agent')).toBe(false);
  });

  it('applies tools, then disallowedTools, which wins', () => {
    const allowed = allowedTools(
      parent,
      {
        tools: ['Read', 'Write', 'Bash', 'AskUserQuestion', 'NotAParentTool'],
        disallowedTools: ['Write'],
      },
      1,
      3,
    );
    expect([...allowed]).toEqual(['Read', 'Bash']);
  });

  it('never grants what the parent does not have', () => {
    expect([...allowedTools(['Read'], { tools: ['Read', 'Bash'] }, 1, 3)]).toEqual(['Read']);
  });
});

describe('definitions', () => {
  const core = {
    agents: [
      {
        name: 'Explore',
        description: 'My explorer',
        source: 'projectClaude',
        prompt: 'Explore my way.',
        path: '/w/.claude/agents/explore.md',
      },
      { name: 'reviewer', description: 'Reviews', source: 'user', prompt: 'Review.', denied: true },
    ],
    issues: [{ path: '/w/.claude/agents/bad.md', line: 2, message: 'invalid YAML' }],
    limits: { maxDepth: 3, maxConcurrent: 8 },
    deniedBuiltIn: ['Plan'],
    aliases: { fast: 'p/m' },
  };

  it('lets a file replace a built-in type and marks denied ones', () => {
    const parsed = parseCoreAgents(core);
    if (parsed === undefined) throw new Error('a valid list');
    const catalog = catalogOf(parsed);
    expect(catalog.agents.map((a) => [a.name, a.source, a.denied === true])).toEqual([
      ['Explore', 'projectClaude', false],
      ['reviewer', 'user', true],
      ['general-purpose', 'builtIn', false],
      ['fork', 'builtIn', false],
      ['Plan', 'builtIn', true],
    ]);
    expect(startable(catalog).map((a) => a.name)).toEqual(['Explore', 'general-purpose', 'fork']);
    expect(catalog.aliases).toEqual({ fast: 'p/m' });
  });

  it('refuses an answer that is not a definitions list', () => {
    expect(parseCoreAgents({ ...core, limits: { maxDepth: 0, maxConcurrent: 8 } })).toBeUndefined();
    expect(
      parseCoreAgents({
        ...core,
        agents: [{ name: 'x', description: 'd', source: 'elsewhere', prompt: '' }],
      }),
    ).toBeUndefined();
    expect(parseCoreAgents({ ...core, aliases: { fast: 3 } })).toBeUndefined();
  });

  it('gives the read-only built-in types read-only tools and no project context', () => {
    const explore = BUILT_IN_TYPES.find((a) => a.name === 'Explore');
    const plan = BUILT_IN_TYPES.find((a) => a.name === 'Plan');
    for (const type of [explore, plan]) {
      expect(type?.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch']);
      expect(type?.omitProjectContext).toBe(true);
    }
    expect(explore?.model).toBe('fast');
    expect(plan?.model).toBe('inherit');
  });
});

describe('Agent tool', () => {
  it('writes its choice parameters as string enums, which every provider accepts', () => {
    const tool = createAgentTool(DEFAULT_PROFILE.Agent, {
      types: BUILT_IN_TYPES,
      run: () => Promise.reject(new Error('not called')),
    });
    const text = JSON.stringify(tool.parameters);
    const schema: unknown = JSON.parse(text);
    expect(schema).toMatchObject({
      properties: {
        model: {
          type: 'string',
          enum: ['inherit', 'fast', 'balanced', 'strong', 'haiku', 'sonnet', 'opus'],
        },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      },
    });
    expect(text).not.toContain('anyOf');
  });
});
