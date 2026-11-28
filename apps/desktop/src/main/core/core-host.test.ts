import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentHostOptions } from './core-host.js';

describe('agentHostOptions', () => {
  it('starts the packaged runtime from the app resources', () => {
    const resourcesPath = path.join('/Applications', 'PiArc.app', 'Contents', 'Resources');
    expect(
      agentHostOptions({
        isPackaged: true,
        appPath: path.join(resourcesPath, 'app.asar'),
        resourcesPath,
      }),
    ).toEqual({ resourcesPath });
  });

  it('runs the development bundle of the source tree on node', () => {
    const appPath = path.join('/src', 'PiArc', 'apps', 'desktop');
    const bundleDir = path.join('/src', 'PiArc', 'agent-host', 'dist', 'bundle');
    expect(agentHostOptions({ isPackaged: false, appPath, resourcesPath: '/unused' })).toEqual({
      node: 'node',
      bundle: path.join(bundleDir, 'agent-host.mjs'),
      piPackageDir: path.join(bundleDir, 'pi-assets'),
    });
  });
});
