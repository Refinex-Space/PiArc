import { describe, expect, it } from 'vitest';

import { workspaceLabels } from './WorkspaceOptions.js';

describe('workspace picker labels', () => {
  it('names a workspace by its folder, with the parent when two share a name', () => {
    const labels = workspaceLabels([
      'C:\\Users\\a\\projects\\piarc',
      '/home/a/work/api',
      '/home/a/old/api',
      '/srv/测试 目录',
    ]);
    expect([...labels.values()]).toEqual(['piarc', 'api — work', 'api — old', '测试 目录']);
  });
});
