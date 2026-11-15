import { describe, expect, it } from 'vitest';

import {
  CANONICAL_TOOLS,
  DEFAULT_PROFILE,
  PI_BUILTIN_TOOL_NAMES,
  profileWithOverrides,
  ToolNameMap,
} from './profile.js';

describe('ToolNameMap', () => {
  it('maps the default profile onto itself in both directions', () => {
    const names = new ToolNameMap(DEFAULT_PROFILE);
    for (const tool of CANONICAL_TOOLS) {
      expect(names.toVisible(tool)).toBe(tool);
      expect(names.toCanonical(tool)).toBe(tool);
    }
    expect(names.toCanonical('mcp__alpha__echo')).toBe('mcp__alpha__echo');
    expect(names.toVisible('mcp__alpha__echo')).toBe('mcp__alpha__echo');
  });

  it('translates renamed tools both ways and leaves other names alone', () => {
    const profile = profileWithOverrides({
      Read: { name: 'read_file' },
      Bash: { name: 'run_shell', description: 'Runs a shell command.' },
    });
    const names = new ToolNameMap(profile);
    expect(names.toVisible('Read')).toBe('read_file');
    expect(names.toCanonical('read_file')).toBe('Read');
    expect(names.toVisible('Bash')).toBe('run_shell');
    expect(names.toCanonical('run_shell')).toBe('Bash');
    expect(names.toCanonical('Read')).toBe('Read');
    expect(names.toVisible('Grep')).toBe('Grep');
    expect(profile.Bash.description).toBe('Runs a shell command.');
    expect(profile.Bash.snippet).toBe(DEFAULT_PROFILE.Bash.snippet);
  });

  it('rejects duplicate, malformed and Pi-reserved names', () => {
    expect(() => profileWithOverrides({ Read: { name: 'Write' } })).toThrow(/both named Write/);
    expect(() => profileWithOverrides({ Read: { name: 'read file' } })).toThrow(/invalid name/);
    for (const reserved of PI_BUILTIN_TOOL_NAMES) {
      expect(() => profileWithOverrides({ Glob: { name: reserved } })).toThrow(/Pi's own tools/);
    }
    expect(() => profileWithOverrides({ Ls: { name: 'ls2' } })).toThrow(/unknown tool Ls/);
    expect(() => profileWithOverrides({ Read: { label: 'x' } })).toThrow(/Read\.label/);
    expect(() => profileWithOverrides([])).toThrow(/expected an object/);
  });
});

describe('DEFAULT_PROFILE', () => {
  it('describes every canonical tool under its canonical name', () => {
    expect(Object.keys(DEFAULT_PROFILE)).toEqual([...CANONICAL_TOOLS]);
    for (const tool of CANONICAL_TOOLS) {
      const presentation = DEFAULT_PROFILE[tool];
      expect(presentation.name).toBe(tool);
      expect(presentation.description.length).toBeGreaterThan(80);
      expect(presentation.snippet.startsWith(`${tool}:`)).toBe(true);
      // The descriptions name tools by canonical name only.
      for (const piName of PI_BUILTIN_TOOL_NAMES) {
        expect(presentation.description).not.toMatch(new RegExp(`\\b${piName} tool\\b`));
      }
    }
  });
});
