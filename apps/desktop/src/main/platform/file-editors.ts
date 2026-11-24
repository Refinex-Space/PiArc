// Resolve known editors from OS installation directories. Project filenames never name
// a program or a shell command; each target is passed as its own process argument.
import path from 'node:path';
import os from 'node:os';
import { access, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
interface Editor {
  id: string;
  name: string;
  mac?: string[];
  windows?: string;
  scheme?: string;
  jetbrains?: string;
}
const catalog: Editor[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    windows: 'Microsoft VS Code/Code.exe',
    scheme: 'vscode',
  },
  {
    id: 'insiders',
    name: 'Visual Studio Code - Insiders',
    windows: 'Microsoft VS Code Insiders/Code - Insiders.exe',
    scheme: 'vscode-insiders',
  },
  { id: 'cursor', name: 'Cursor', windows: 'cursor/Cursor.exe', scheme: 'cursor' },
  { id: 'windsurf', name: 'Windsurf', windows: 'Windsurf/Windsurf.exe', scheme: 'windsurf' },
  { id: 'zed', name: 'Zed', mac: ['Zed', 'Zed Preview'], windows: 'Zed/Zed.exe', scheme: 'zed' },
  { id: 'sublime', name: 'Sublime Text', windows: 'Sublime Text/sublime_text.exe' },
  { id: 'bbedit', name: 'BBEdit' },
  { id: 'nova', name: 'Nova' },
  {
    id: 'idea',
    name: 'IntelliJ IDEA',
    mac: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'],
    jetbrains: 'idea64',
  },
  {
    id: 'pycharm',
    name: 'PyCharm',
    mac: ['PyCharm', 'PyCharm CE', 'PyCharm Professional Edition', 'PyCharm Community Edition'],
    jetbrains: 'pycharm64',
  },
  { id: 'webstorm', name: 'WebStorm', jetbrains: 'webstorm64' },
  { id: 'goland', name: 'GoLand', jetbrains: 'goland64' },
  { id: 'rustrover', name: 'RustRover', jetbrains: 'rustrover64' },
  { id: 'phpstorm', name: 'PhpStorm', jetbrains: 'phpstorm64' },
  { id: 'rubymine', name: 'RubyMine', jetbrains: 'rubymine64' },
  { id: 'clion', name: 'CLion', jetbrains: 'clion64' },
  { id: 'fleet', name: 'Fleet', windows: 'Fleet/Fleet.exe' },
  { id: 'studio', name: 'Android Studio', windows: 'Android/Android Studio/bin/studio64.exe' },
];
function missing(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))
  );
}
async function children(root: string) {
  try {
    return await readdir(root);
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}
export async function installedEditors() {
  const home = path.join(os.homedir(), 'Applications');
  const macRoots = [
    '/Applications',
    home,
    path.join(home, 'JetBrains Toolbox'),
    '/Applications/Setapp',
  ];
  const windowsRoots = [
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter((v): v is string => !!v);
  const jetbrains =
    process.platform === 'win32'
      ? await Promise.all(
          windowsRoots.map(async (r) => {
            const root = path.join(r, 'JetBrains');
            return (await children(root))
              .sort()
              .reverse()
              .map((n) => ({ name: n, root: path.join(root, n) }));
          }),
        )
      : [];
  const found = await Promise.all(
    catalog.map(async (editor) => {
      const candidates =
        process.platform === 'darwin'
          ? macRoots.flatMap((root) =>
              (editor.mac ?? [editor.name]).map((name) => path.join(root, name + '.app')),
            )
          : [
              ...(editor.windows
                ? windowsRoots.map((root) => path.join(root, editor.windows ?? ''))
                : []),
              ...jetbrains
                .flat()
                .filter((e) => editor.jetbrains && e.name.startsWith(editor.name))
                .map((e) => path.join(e.root, 'bin', (editor.jetbrains ?? '') + '.exe')),
            ];
      for (const executable of candidates) {
        try {
          await access(executable);
          return { ...editor, executable };
        } catch (e) {
          if (!missing(e)) throw e;
        }
      }
      return undefined;
    }),
  );
  return found.filter((e) => e !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
export async function openInFileEditor(action: string, target: string, directory: boolean) {
  const match = /^editor:([a-z]+)(?::([1-9]\d{0,7}))?$/u.exec(action);
  const editor = match && (await installedEditors()).find((e) => e.id === match[1]);
  if (!editor) throw new TypeError('Unknown editor');
  const line = directory ? undefined : match[2];
  if (process.platform === 'darwin') {
    let value = target;
    if (line && editor.scheme) {
      const url = new URL(editor.scheme + '://file/');
      url.pathname = target + ':' + line;
      value = url.href;
    }
    await promisify(execFile)('/usr/bin/open', ['-a', editor.executable, value], {
      timeout: 15000,
    });
    return;
  }
  const args =
    line && editor.scheme && editor.id !== 'zed'
      ? ['--goto', target + ':' + line]
      : line && editor.jetbrains
        ? ['--line', line, target]
        : [target];
  const child = spawn(editor.executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
