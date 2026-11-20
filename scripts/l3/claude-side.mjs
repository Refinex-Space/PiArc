// The Claude Code side of L3 (T30): runs one scenario with `claude -p` against the strict
// mock in L3 mode and returns a structure-only capture in the shape of the PiArc side's
// (`piarc-devcli l3`).
//
// Isolation (docs/engineering/testing.md section 14.2): every run gets its own temporary
// root holding the workspace copy, the configuration directory (CLAUDE_CONFIG_DIR, which
// also keys the macOS keychain entry to it), HOME, the mock script and the approval fixture.
// The environment is built from scratch: a fake ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL at the
// mock, the scenario header, and the switches that turn off non-essential traffic. Nothing
// reads or writes ~/.claude or the user's login.
//
// The stream-json output is read in memory; only tool call ids, names and statuses, the
// permission denials and the final status leave this module.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { isRecord, repoRoot } from '../lib/repo.mjs';
import { L3_DIR, mockScript, workspaceFiles } from './scenario.mjs';
import { fileHashes, jsonLines } from './files.mjs';

/** Name of the approval tool on the fixture MCP server. */
export const PROMPT_TOOL = 'mcp__l3__approve';
const FAKE_KEY = 'sk-ant-piarc-l3-not-a-key';
const RUN_TIMEOUT_MS = 180_000;

/**
 * The environment of a `claude` run: nothing inherited except what starting a process
 * needs on each platform.
 * @param {{ home: string, config: string, port: string, scenario: string }} run
 * @returns {NodeJS.ProcessEnv}
 */
export function claudeEnv(run) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env.PATH,
    HOME: run.home,
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: run.config,
    ANTHROPIC_API_KEY: FAKE_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${run.port}`,
    ANTHROPIC_CUSTOM_HEADERS: `x-piarc-scenario: ${run.scenario}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Also skips the title request to the small model (an auxiliary request).
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  };
  for (const name of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.platform === 'win32') env.USERPROFILE = run.home;
  return env;
}

/**
 * Starts the mock provider bin in L3 mode on a free port.
 * @param {string} scriptFile
 * @returns {Promise<{ port: string, stop: () => void }>}
 */
export function startMock(scriptFile) {
  const exe = process.platform === 'win32' ? 'piarc-mock-provider.exe' : 'piarc-mock-provider';
  const bin = path.join(repoRoot, 'target', 'debug', exe);
  const mock = spawn(bin, ['--port', '0', '--l3', '--scenarios', scriptFile], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    mock.on('error', reject);
    readline.createInterface({ input: mock.stdout }).once('line', (port) => {
      resolve({ port: port.trim(), stop: () => mock.stdin.end() });
    });
  });
}

/**
 * Runs `claude` and collects the stream-json lines it prints.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ code: number, lines: unknown[], stderrBytes: number }>}
 */
function runClaude(args, options) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {unknown[]} */
    const lines = [];
    let stderrBytes = 0;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() === '') return;
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ type: 'unparsed' });
      }
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      stderrBytes += chunk.length;
    });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('error', () => {
      resolve({ code: 127, lines, stderrBytes });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, lines, stderrBytes });
    });
  });
}

/**
 * Tool calls, denials and the final status from the stream-json messages.
 * @param {unknown[]} lines
 */
export function readStream(lines) {
  /** @type {{ id: string, tool: string, status: string }[]} */
  const calls = [];
  /** @type {Map<string, boolean>} */
  const errors = new Map();
  /** @type {Set<string>} */
  const denied = new Set();
  let status = 'failed';
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const message = isRecord(line.message) ? line.message : {};
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    // Calls of subagents (parent_tool_use_id set) are not the main loop's.
    if (line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined) continue;
    if (line.type === 'assistant') {
      for (const block of content.filter((b) => b.type === 'tool_use')) {
        calls.push({ id: String(block.id), tool: String(block.name), status: 'completed' });
      }
    } else if (line.type === 'user') {
      for (const block of content.filter((b) => b.type === 'tool_result')) {
        errors.set(String(block.tool_use_id), block.is_error === true);
      }
    } else if (line.type === 'result') {
      for (const denial of Array.isArray(line.permission_denials) ? line.permission_denials : []) {
        if (isRecord(denial)) denied.add(String(denial.tool_use_id));
      }
      status = line.subtype === 'success' && line.is_error !== true ? 'completed' : 'failed';
    }
  }
  for (const call of calls) {
    if (denied.has(call.id)) call.status = 'declined';
    else if (errors.get(call.id) === true) call.status = 'failed';
    else if (!errors.has(call.id)) call.status = 'interrupted';
  }
  return { calls, status };
}

/**
 * `claude --version`, or undefined when there is no `claude` on PATH.
 * @returns {Promise<string | undefined>}
 */
export function claudeVersion() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      resolve(undefined);
    });
    child.on('close', (code) => {
      const version = /\d+\.\d+\.\d+/.exec(out)?.[0];
      resolve(code === 0 ? version : undefined);
    });
  });
}

/**
 * Runs `scenario` on Claude Code and returns its capture.
 * @param {import('./scenario.mjs').Scenario} scenario
 */
export async function runClaudeSide(scenario) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'piarc-l3-')));
  const workspace = path.join(root, 'work space 工作区');
  const config = path.join(root, 'config');
  const home = path.join(root, 'home');
  try {
    for (const dir of [workspace, config, home]) mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(workspaceFiles(scenario))) {
      const target = path.join(workspace, ...file.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    // -p shows no trust dialog: trust the workspace the way the dialog would, so project
    // allow rules apply as they do in PiArc's trusted project.
    writeFileSync(
      path.join(config, '.claude.json'),
      JSON.stringify({ projects: { [workspace]: { hasTrustDialogAccepted: scenario.trusted } } }),
    );
    if (scenario.workspace.user_settings !== undefined) {
      writeFileSync(
        path.join(config, 'settings.json'),
        JSON.stringify(scenario.workspace.user_settings),
      );
    }
    const scriptFile = path.join(root, `${scenario.id}.json`);
    writeFileSync(scriptFile, JSON.stringify(mockScript(scenario, workspace)));
    const answers = path.join(root, 'answers.json');
    const asks = path.join(root, 'asks.jsonl');
    writeFileSync(answers, JSON.stringify(scenario.approvals));
    const server = path.join(repoRoot, 'scripts', 'l3', 'fixtures', 'approval-server.mjs');
    const mcp = path.join(root, 'mcp.json');
    writeFileSync(
      mcp,
      JSON.stringify({
        mcpServers: {
          l3: { type: 'stdio', command: process.execPath, args: [server, answers, asks] },
        },
      }),
    );
    const mock = await startMock(scriptFile);
    try {
      const args = [
        '-p',
        scenario.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--mcp-config',
        mcp,
        '--strict-mcp-config',
        '--permission-prompt-tool',
        PROMPT_TOOL,
        ...(scenario.mode === undefined ? [] : ['--permission-mode', scenario.mode]),
        ...(scenario.mode === 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
      ];
      const env = claudeEnv({ home, config, port: mock.port, scenario: scenario.id });
      const result = await runClaude(args, { cwd: workspace, env });
      const response = await fetch(`http://127.0.0.1:${mock.port}/_piarc/requests`);
      /** @type {unknown} */
      const records = await response.json();
      const stream = readStream(result.lines);
      return {
        workspace,
        home,
        root,
        exit: result.code,
        stderrBytes: result.stderrBytes,
        requests: (Array.isArray(records) ? records : []).filter(isRecord).map((r) => ({
          structure: r.structure ?? null,
          outcome: r.outcome,
          violations: Array.isArray(r.violations)
            ? r.violations.filter(isRecord).map((v) => String(v.rule))
            : [],
        })),
        tool_calls: stream.calls,
        status: stream.status,
        asks: jsonLines(readText(asks)),
        files: fileHashes(workspace, [L3_DIR]),
        hooks: jsonLines(readText(path.join(workspace, L3_DIR, 'hooks.jsonl'))),
      };
    } finally {
      mock.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} file */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
