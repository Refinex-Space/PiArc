// A minimal stdio MCP server for tests (S3, T06, T36), written by hand against the MCP
// specification and independent of pi-mcp, so a framing mistake in PiArc's client shows up
// instead of being mirrored. Run directly with Node (type stripping): `node mcp-echo-server.ts
// <server name>`. Newline-delimited JSON-RPC on stdin/stdout, as MCP's stdio transport.
//
// Tools:
// - `echo` (`text`): names the server, its working directory and its process id, so a test can
//   tell which server instance answered which session;
// - `whoami`: the server's process id, its process group (POSIX), the Node that runs it, and
//   the values of the variables named in `MCP_ECHO_SHOW` (comma-separated);
// - `add_tool` (`name`): offers one more tool and sends `notifications/tools/list_changed`;
// - `add_prompt` (`name`): with prompts on, offers one more prompt and sends
//   `notifications/prompts/list_changed` (T40).
//
// Environment knobs:
// - `MCP_ECHO_TOOLS=<n>`: also offer `extra_1` … `extra_<n>` (for the deferral threshold);
// - `MCP_ECHO_INTERACTIVE=1`: `echo` carries `_meta["anthropic/requiresUserInteraction"]`;
// - `MCP_ECHO_INSTRUCTIONS=<text>`: the `instructions` of `initialize`;
// - `MCP_ECHO_STUBBORN=1`: ignore SIGTERM and the end of stdin (only SIGKILL ends it);
// - `MCP_ECHO_PID_FILE=<path>`: write the process id there on start;
// - `MCP_ECHO_PROMPTS=1`: declare the `prompts` capability with `greet` (arguments `name`,
//   required, and `tone`) and `picture` (an image message, which PiArc does not send) (T40);
// - `MCP_ECHO_START_LOG=<path>`: append `{"server","pid"}` as one JSON line there on start
//   (relative to the working directory), so a test can count the server's processes.
// - `MCP_ECHO_REPLY=1`: also offer `reply` (`text`, `delay_ms`, `is_error`), which answers
//   `text` verbatim after `delay_ms` milliseconds (T41's `mcp_tool` hooks).
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';

const serverName = process.argv[2] ?? 'echo';
const env = process.env;
const extra = Number.parseInt(env.MCP_ECHO_TOOLS ?? '0', 10);
const added: string[] = [];
const prompts = env.MCP_ECHO_PROMPTS === '1';
const addedPrompts: string[] = [];

if (env.MCP_ECHO_PID_FILE !== undefined) writeFileSync(env.MCP_ECHO_PID_FILE, String(process.pid));
if (env.MCP_ECHO_START_LOG !== undefined) {
  appendFileSync(
    env.MCP_ECHO_START_LOG,
    `${JSON.stringify({ server: serverName, pid: process.pid })}\n`,
  );
}
if (env.MCP_ECHO_STUBBORN === '1') {
  process.on('SIGTERM', () => undefined);
  // Outlives the end of stdin.
  setInterval(() => undefined, 60_000);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

function processGroup(): string {
  if (process.platform === 'win32') return '';
  try {
    return execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)])
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function tools(): unknown[] {
  const list: unknown[] = [
    {
      name: 'echo',
      description: `Echoes text back from the ${serverName} server.`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      ...(env.MCP_ECHO_INTERACTIVE === '1'
        ? { _meta: { 'anthropic/requiresUserInteraction': true } }
        : {}),
    },
    {
      name: 'whoami',
      description: `Reports the process of the ${serverName} server.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_tool',
      description: `Adds a tool to the ${serverName} server.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  ];
  if (env.MCP_ECHO_REPLY === '1') {
    list.push({
      name: 'reply',
      description: `Answers the given text from the ${serverName} server.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          delay_ms: { type: 'number' },
          is_error: { type: 'boolean' },
        },
        required: ['text'],
      },
    });
  }
  if (prompts) {
    list.push({
      name: 'add_prompt',
      description: `Adds a prompt to the ${serverName} server.`,
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
  }
  for (let n = 1; n <= extra; n++) {
    list.push({
      name: `extra_${String(n)}`,
      description: `Extra tool number ${String(n)} of ${serverName}, about topic${String(n)}.`,
      inputSchema: { type: 'object', properties: {} },
    });
  }
  for (const name of added) {
    list.push({
      name,
      description: `A tool ${serverName} added later.`,
      inputSchema: { type: 'object', properties: {} },
    });
  }
  return list;
}

function promptList(): unknown[] {
  return [
    {
      name: 'greet',
      description: `Greets someone, from the ${serverName} server.`,
      arguments: [
        { name: 'name', description: 'Who to greet', required: true },
        { name: 'tone', description: 'How' },
      ],
    },
    { name: 'picture', description: 'A picture prompt.' },
    ...addedPrompts.map((name) => ({ name, description: `A prompt ${serverName} added later.` })),
  ];
}

function getPrompt(name: string, args: Record<string, unknown>): unknown {
  if (name === 'greet') {
    const who = typeof args.name === 'string' ? args.name : '';
    const tone = typeof args.tone === 'string' ? args.tone : 'plain';
    return {
      description: 'A greeting',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Please greet ${who} in a ${tone} tone (${serverName}).` },
        },
      ],
    };
  }
  if (name === 'picture') {
    return {
      messages: [{ role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }],
    };
  }
  if (addedPrompts.includes(name)) {
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `${name} from ${serverName}` } }],
    };
  }
  return undefined;
}

function call(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'echo': {
      const value = typeof args.text === 'string' ? args.text : '';
      return text(
        `${serverName} echoes "${value}" from ${process.cwd()} (pid ${String(process.pid)})`,
      );
    }
    case 'whoami': {
      const shown = Object.fromEntries(
        (env.MCP_ECHO_SHOW ?? '')
          .split(',')
          .filter((key) => key !== '')
          .map((key) => [key, env[key] ?? null]),
      );
      return text(
        JSON.stringify({
          pid: process.pid,
          pgid: processGroup(),
          node: process.execPath,
          env: shown,
        }),
      );
    }
    case 'add_tool': {
      const toolName = typeof args.name === 'string' ? args.name : 'later';
      added.push(toolName);
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return text(`added ${toolName}`);
    }
    case 'add_prompt': {
      const promptName = typeof args.name === 'string' ? args.name : 'later';
      addedPrompts.push(promptName);
      send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
      return text(`added prompt ${promptName}`);
    }
    default:
      if (/^extra_\d+$/.test(name) || added.includes(name))
        return text(`${name} ran on ${serverName}`);
      return undefined;
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') {
    continue;
  }
  const message: unknown = JSON.parse(line);
  if (!isRecord(message) || typeof message.method !== 'string' || !('id' in message)) {
    continue; // notifications (`notifications/initialized`) and responses need no answer
  }
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: {
          tools: { listChanged: true },
          ...(prompts ? { prompts: { listChanged: true } } : {}),
        },
        serverInfo: { name: serverName, version: '0.0.0' },
        ...(env.MCP_ECHO_INSTRUCTIONS === undefined
          ? {}
          : { instructions: env.MCP_ECHO_INSTRUCTIONS }),
      });
      break;
    case 'ping':
      reply(message.id, {});
      break;
    case 'tools/list':
      reply(message.id, { tools: tools() });
      break;
    case 'prompts/list':
      if (prompts) reply(message.id, { prompts: promptList() });
      else fail(message.id, -32601, 'method not found: prompts/list');
      break;
    case 'prompts/get': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = prompts
        ? getPrompt(typeof params.name === 'string' ? params.name : '', args)
        : undefined;
      if (result === undefined) fail(message.id, -32602, `unknown prompt: ${String(params.name)}`);
      else reply(message.id, result);
      break;
    }
    case 'tools/call': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (params.name === 'reply' && env.MCP_ECHO_REPLY === '1') {
        const answer = {
          content: [{ type: 'text', text: typeof args.text === 'string' ? args.text : '' }],
          ...(args.is_error === true ? { isError: true } : {}),
        };
        const delay = typeof args.delay_ms === 'number' ? args.delay_ms : 0;
        setTimeout(() => {
          reply(message.id, answer);
        }, delay);
        break;
      }
      const result = call(typeof params.name === 'string' ? params.name : '', args);
      if (result === undefined) fail(message.id, -32602, `unknown tool: ${String(params.name)}`);
      else reply(message.id, result);
      break;
    }
    default:
      fail(message.id, -32601, `method not found: ${message.method}`);
  }
}
