// L3 approval fixture (T30): a stdio MCP server whose one tool, `approve`, answers Claude
// Code's permission prompts (`claude -p --permission-prompt-tool mcp__l3__approve`) in the
// order a scenario scripts them, the way the L2 runner answers PiArc's approval cards.
//
//   node approval-server.mjs <answers.json> <asks.jsonl>
//
// answers.json is the scenario's `approvals` list ([{call, decision: "allow" | "deny",
// feedback?}]); a prompt gets the answer naming its tool_use_id, and a prompt no answer names
// is refused. Every prompt appends {tool, call, decision, scripted} to asks.jsonl (no tool
// input). Messages are newline-delimited
// JSON-RPC 2.0 (the MCP stdio transport).
import { appendFileSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const [answersFile = '', asksFile = ''] = process.argv.slice(2);
if (answersFile === '' || asksFile === '') {
  console.error('usage: approval-server.mjs <answers.json> <asks.jsonl>');
  process.exit(2);
}
/** @type {unknown} */
const parsed = JSON.parse(readFileSync(answersFile, 'utf8'));
const answers = Array.isArray(parsed) ? parsed.filter(isRecord) : [];

/** @param {Record<string, unknown>} message */
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

/** @param {Record<string, unknown>} args @returns {Record<string, unknown>} */
function decide(args) {
  const call = typeof args.tool_use_id === 'string' ? args.tool_use_id : null;
  const answer = answers.find((a) => a.call === call);
  const tool = typeof args.tool_name === 'string' ? args.tool_name : null;
  const allow = answer?.decision === 'allow';
  appendFileSync(
    asksFile,
    `${JSON.stringify({ tool, call, decision: allow ? 'allow' : 'deny', scripted: answer !== undefined })}\n`,
  );
  if (allow) return { behavior: 'allow', updatedInput: isRecord(args.input) ? args.input : {} };
  const feedback = typeof answer?.feedback === 'string' ? answer.feedback : 'Refused.';
  return { behavior: 'deny', message: feedback };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  /** @type {unknown} */
  const message = JSON.parse(line);
  if (!isRecord(message) || message.id === undefined) return; // notifications need no answer
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'piarc-l3-approvals', version: '1' },
        },
      });
      break;
    case 'tools/list':
      send({
        id: message.id,
        result: {
          tools: [
            {
              name: 'approve',
              description: 'Answers permission prompts for the L3 comparison.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
      break;
    case 'tools/call': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      send({
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(decide(args)) }] },
      });
      break;
    }
    default:
      send({ id: message.id, result: {} });
  }
});
