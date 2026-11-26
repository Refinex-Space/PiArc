// A real Git repository for L4 (the Git tool, ADR-0084): main with two files, feature/login
// with one more commit, then a modified README and an untracked file. Git runs without the
// machine's configuration.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
