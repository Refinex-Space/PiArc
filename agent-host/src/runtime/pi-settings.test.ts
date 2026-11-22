// THR-03 (T45): Pi's package manager installs every source of the `packages` lists in Pi's
// settings it cannot find, with npm's install scripts, whenever the resource loader reloads.
// The Agent Host's settings must hide those lists, so nothing installs and nothing loads.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withoutPiPackages } from './pi-settings.js';

let root: string;
let workspace: string;
let agentDir: string;

/** A package whose install script leaves `POSTINSTALL-RAN` in its own directory. */
async function writePackage(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      pi: { extensions: ['./probe.js'] },
      scripts: { postinstall: 'node marker.js' },
    }),
  );
  await writeFile(
    path.join(dir, 'marker.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, 'POSTINSTALL-RAN'), 'ran');\n",
  );
  await writeFile(path.join(dir, 'probe.js'), 'module.exports = function () {};\n');
}

beforeEach(async () => {
  vi.stubEnv('PI_OFFLINE', undefined);
  root = await mkdtemp(path.join(os.tmpdir(), 'piarc pi settings 设置 '));
  workspace = path.join(root, 'work space');
  agentDir = path.join(root, 'agent');
  await writePackage(path.join(workspace, 'vendor', 'project-npm'), 'project-npm');
  await writePackage(path.join(workspace, 'vendor', 'project-local'), 'project-local');
  await writePackage(path.join(workspace, 'vendor', 'user-npm'), 'user-npm');
  await mkdir(path.join(workspace, '.pi'), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(workspace, '.pi', 'settings.json'),
    JSON.stringify({
      packages: [
        `npm:${path.join(workspace, 'vendor', 'project-npm')}`,
        path.join(workspace, 'vendor', 'project-local'),
      ],
    }),
  );
  await writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ packages: [`npm:${path.join(workspace, 'vendor', 'user-npm')}`] }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function ran(name: string): boolean {
  return existsSync(path.join(workspace, 'vendor', name, 'POSTINSTALL-RAN'));
}

describe('Pi settings without packages (THR-03)', () => {
  it(
    'premise: Pi itself installs the packages of its settings and runs their install scripts',
    { timeout: 60_000 },
    async () => {
      const settings = SettingsManager.create(workspace, agentDir, { projectTrusted: true });
      const packages = new DefaultPackageManager({
        cwd: workspace,
        agentDir,
        settingsManager: settings,
      });
      const resolved = await packages.resolve();
      expect(ran('project-npm')).toBe(true);
      expect(ran('user-npm')).toBe(true);
      expect(resolved.extensions.map((r) => path.basename(path.dirname(r.path)))).toContain(
        'project-local',
      );
    },
  );

  it('THR-03 hides every package source from Pi, so nothing installs, runs or loads', async () => {
    const settings = withoutPiPackages(
      SettingsManager.create(workspace, agentDir, { projectTrusted: true }),
    );
    expect(settings.getGlobalSettings().packages).toBeUndefined();
    expect(settings.getProjectSettings().packages).toBeUndefined();
    const packages = new DefaultPackageManager({
      cwd: workspace,
      agentDir,
      settingsManager: settings,
    });
    const resolved = await packages.resolve();
    expect(resolved.extensions).toEqual([]);
    expect(ran('project-npm')).toBe(false);
    expect(ran('user-npm')).toBe(false);
    expect(existsSync(path.join(agentDir, 'npm'))).toBe(false);
    expect(existsSync(path.join(workspace, '.pi', 'npm'))).toBe(false);
  });

  it('keeps the other settings readable', () => {
    const settings = withoutPiPackages(
      SettingsManager.create(workspace, agentDir, { projectTrusted: true }),
    );
    expect(settings.getGlobalSettings()).toEqual({});
    expect(settings.isProjectTrusted()).toBe(true);
  });
});
