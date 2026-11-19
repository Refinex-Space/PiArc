import { describe, expect, it } from 'vitest';

import { TIMED, parts } from './cargo-test.mjs';

describe('cargo test step', () => {
  it('skips each timing test in the workspace run and then runs it alone', () => {
    const [workspace, ...alone] = parts();
    expect(workspace?.args.slice(0, 4)).toEqual(['test', '--workspace', '--locked', '--']);
    for (const test of TIMED) {
      expect(workspace?.args).toContain(test.name);
      expect(workspace?.args[workspace.args.indexOf(test.name) - 1]).toBe('--skip');
    }
    expect(alone).toHaveLength(TIMED.length);
    alone.forEach((part, i) => {
      const test = TIMED[i];
      expect(part.args).toEqual(expect.arrayContaining(['-p', test?.pkg, test?.name, '--exact']));
    });
  });
});
