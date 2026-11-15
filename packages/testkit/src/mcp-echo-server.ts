// A minimal stdio MCP server for tests (S3, T06): one tool, `echo`, whose result names the
// server, its working directory and its process id, so a test can tell which server instance
// answered which session. Run directly with Node (type stripping): `node mcp-echo-server.ts
// <server name>`. Newline-delimited JSON-RPC on stdin/stdout, as MCP's stdio transport.
import { createInterface } from 'node:readline';

const serverName = process.argv[2] ?? 'echo';

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '0.0.0' },
      });
      break;
    case 'ping':
      reply(message.id, {});
      break;
    case 'tools/list':
      reply(message.id, {
        tools: [
          {
            name: 'echo',
            description: `Echoes text back from the ${serverName} server.`,
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      const text = typeof args.text === 'string' ? args.text : '';
      reply(message.id, {
        content: [
          {
            type: 'text',
            text: `${serverName} echoes "${text}" from ${process.cwd()} (pid ${String(process.pid)})`,
          },
        ],
      });
      break;
    }
    default:
      fail(message.id, -32601, `method not found: ${message.method}`);
  }
}
