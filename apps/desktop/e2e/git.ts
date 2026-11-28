// A real Git repository for L4 (the Git tool, ADR-0084): main with two files, feature/login
// with one more commit, then a modified README and an untracked file. Git runs without the
// machine's configuration.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Git without the machine's configuration. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  return stdout.trim();
}

const APP =
  Array.from(
    { length: 30 },
    (_, i) => `export const line${String(i + 1)} = ${String(i + 1)};`,
  ).join('\n') + '\n';

/** main: README and src/app.ts; feature/login: one more commit; then uncommitted changes. */
export async function makeRepository(ws: string): Promise<void> {
  await mkdir(path.join(ws, 'src'), { recursive: true });
  await git(ws, 'init', '-q', '-b', 'main');
  for (const [key, value] of [
    ['user.name', 'PiArc Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    await git(ws, 'config', key, value);
  }
  await writeFile(path.join(ws, 'src', 'app.ts'), APP);
  await writeFile(path.join(ws, 'README.md'), '# Demo\n\nA demo project.\n');
  await git(ws, 'add', '-A');
  await git(ws, 'commit', '-q', '-m', 'chore: initial commit');
  await git(ws, 'checkout', '-q', '-b', 'feature/login');
  await writeFile(path.join(ws, 'src', 'app.ts'), APP.replace('line3 = 3', "line3 = 'three'"));
  await writeFile(
    path.join(ws, 'src', 'login.ts'),
    'export function login(): boolean {\n  return true;\n}\n',
  );
  await git(ws, 'add', '-A');
  await git(ws, 'commit', '-q', '-m', 'feat: add login');
  await writeFile(path.join(ws, 'README.md'), '# Demo\n\nA demo project with sign-in.\n');
  await writeFile(path.join(ws, 'notes.txt'), 'remember the tests\n');
}

/** main changes line 3 of src/app.ts differently from feature/login (still checked out). */
export async function conflictOnMain(ws: string): Promise<void> {
  await git(ws, 'stash', '-q', '-u');
  await git(ws, 'checkout', '-q', 'main');
  const file = path.join(ws, 'src', 'app.ts');
  await writeFile(file, (await readFile(file, 'utf8')).replace('line3 = 3', "line3 = 'tres'"));
  await git(ws, 'commit', '-q', '-am', 'fix: line 3 on main');
  await git(ws, 'checkout', '-q', 'feature/login');
  await git(ws, 'stash', 'pop', '-q');
}

/** A fake `gh` (G5): what the Git tool runs instead of the machine's own through `PIARC_TEST_GH`. */
export interface FakeGh {
  /** The program, an executable Node script. */
  readonly program: string;
  /** Forgets its pull request and calls (start of a test). */
  reset(): void;
  /** The arguments of every call, in order. */
  calls(): string[][];
  /** The body a `pr create` read from stdin. */
  body(): string;
  /** Changes fields of the pull request `pr view` answers with. */
  update(fields: Record<string, unknown>): void;
}

const FAKE_GH = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const prFile = path.join(dir, 'pr.json');
const flag = (name) => args.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const [command, sub] = args;
if (command === 'pr' && sub === 'view') {
  if (!fs.existsSync(prFile)) {
    process.stderr.write('no pull requests found for branch "' + args.at(-1) + '"\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(prFile));
} else if (command === 'pr' && sub === 'create') {
  fs.writeFileSync(path.join(dir, 'body.md'), fs.readFileSync(0));
  const pr = {
    number: 12,
    title: flag('title'),
    state: 'OPEN',
    isDraft: args.includes('--draft'),
    url: 'https://github.com/octo/app/pull/12',
    baseRefName: flag('base'),
    headRefName: flag('head'),
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ],
  };
  fs.writeFileSync(prFile, JSON.stringify(pr));
  process.stdout.write(pr.url + '\n');
} else if (command === 'pr' && sub === 'merge') {
  const pr = JSON.parse(fs.readFileSync(prFile, 'utf8'));
  pr.state = 'MERGED';
  fs.writeFileSync(prFile, JSON.stringify(pr));
} else {
  process.stderr.write('unexpected call\n');
  process.exit(2);
}
`;

/** Writes a fake `gh` into a new directory (synchronously: a spec passes it as `appEnv`). */
export function fakeGh(): FakeGh {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'piarc fake gh 工具-'));
  const program = path.join(dir, 'gh');
  writeFileSync(program, `#!${process.execPath}\n${FAKE_GH}`);
  chmodSync(program, 0o755);
  const file = (name: string) => path.join(dir, name);
  return {
    program,
    reset: () => {
      for (const name of ['calls.log', 'pr.json', 'body.md']) rmSync(file(name), { force: true });
    },
    calls: () =>
      existsSync(file('calls.log'))
        ? readFileSync(file('calls.log'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[])
        : [],
    body: () => readFileSync(file('body.md'), 'utf8'),
    update: (fields) => {
      const pr = JSON.parse(readFileSync(file('pr.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(file('pr.json'), JSON.stringify({ ...pr, ...fields }));
    },
  };
}

/**
 * `origin` names `github.com/octo/app` but pushes to a local bare repository, so the Git tool
 * sees a GitHub remote and every push stays on this machine; main is pushed (origin/main).
 */
export async function githubRemote(ws: string): Promise<string> {
  const bare = path.join(mkdtempSync(path.join(os.tmpdir(), 'piarc-github-')), 'app 远端.git');
  await git(ws, 'init', '-q', '--bare', '-b', 'main', bare);
  await git(ws, 'remote', 'add', 'origin', 'git@github.com:octo/app.git');
  await git(ws, 'config', 'remote.origin.pushurl', bare);
  await git(ws, 'push', '-q', 'origin', 'main');
  return bare;
}
