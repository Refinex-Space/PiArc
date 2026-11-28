// pi-ai against the strict mock provider: one tool-call round trip per wire format
// (T05-A09, T05-A10). The provider is a custom pi-ai provider whose only auth is a
// constant test API key; no OAuth path exists in it (ADR-0006, T05-A11).
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildMockProvider,
  startMockProvider,
  type MockProviderProcess,
  type RequestRecord,
} from './mock-provider.js';

/** A fixed test key. It is not a credential and must not look like an OAuth token. */
const TEST_API_KEY = 'piarc-mock-test-key';
const SCENARIOS = fileURLToPath(new URL('../scenarios', import.meta.url));
const SYSTEM_PROMPT =
  'You are a test agent.\n<piarc-test-environment>mock</piarc-test-environment>';
const ARGUMENTS = { path: 'dir with space/中文.txt', encoding: 'utf-8' };
/** Compact JSON with sorted keys, exactly as the mock streams it. */
const ARGUMENTS_JSON = '{"encoding":"utf-8","path":"dir with space/中文.txt"}';

const readFile: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, encoding: { type: 'string' } },
    required: ['path'],
  },
};

let mock: MockProviderProcess;

beforeAll(async () => {
  mock = await startMockProvider(await buildMockProvider(), [SCENARIOS]);
}, 300_000);

afterAll(async () => {
  expect(await mock.stop()).toBe(0);
});

interface Scenario {
  api: Api;
  id: string;
  baseUrl: () => string;
  streams: () => ProviderStreams;
  /** How the request names the scenario. */
  selectBy: 'header' | 'marker';
}

function mockModel(scenario: Scenario): Model<Api> {
  return {
    id: 'piarc-mock-model',
    name: 'PiArc mock model',
    api: scenario.api,
    provider: 'piarc-mock',
    baseUrl: scenario.baseUrl(),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...(scenario.selectBy === 'header' ? { headers: { 'x-piarc-scenario': scenario.id } } : {}),
  };
}

function mockModels(scenario: Scenario, model: Model<Api>) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: 'piarc-mock',
      name: 'PiArc mock provider',
      auth: {
        apiKey: {
          name: 'PiArc mock test key',
          resolve: () => Promise.resolve({ auth: { apiKey: TEST_API_KEY }, source: 'test' }),
        },
      },
      models: [model],
      api: scenario.streams(),
    }),
  );
  return models;
}

interface Collected {
  message: AssistantMessage;
  toolCallDeltas: string[];
}

async function collect(stream: AssistantMessageEventStream): Promise<Collected> {
  const toolCallDeltas: string[] = [];
  for await (const event of stream) {
    if (event.type === 'toolcall_delta') {
      toolCallDeltas.push(event.delta);
    } else if (event.type === 'error') {
      throw new Error(`stream failed: ${event.error.errorMessage ?? 'no message'}`);
    }
  }
  return { message: await stream.result(), toolCallDeltas };
}

function isToolCall(block: AssistantMessage['content'][number]): block is ToolCall {
  return block.type === 'toolCall';
}

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function bodyOf(record: RequestRecord): Record<string, unknown> {
  const body: unknown = JSON.parse(record.body);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new TypeError('the recorded body is not a JSON object');
  }
  return Object.fromEntries(Object.entries(body));
}

/** Whether the follow-up request answers `toolCallId` in the wire format's own shape. */
function answersToolCall(api: Api, record: RequestRecord, toolCallId: string): boolean {
  const messages = bodyOf(record).messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  const serialized = messages.map((message) => JSON.stringify(message));
  return api === 'anthropic-messages'
    ? serialized.some(
        (message) =>
          message.includes('"role":"user"') &&
          message.includes(`"type":"tool_result","tool_use_id":${JSON.stringify(toolCallId)}`),
      )
    : serialized.some(
        (message) =>
          message.includes('"role":"tool"') &&
          message.includes(`"tool_call_id":${JSON.stringify(toolCallId)}`),
      );
}

const scenarios: Scenario[] = [
  {
    api: 'anthropic-messages',
    id: 'pi-ai-anthropic-roundtrip',
    baseUrl: () => mock.anthropicBaseUrl,
    streams: anthropicMessagesApi,
    selectBy: 'header',
  },
  {
    api: 'openai-completions',
    id: 'pi-ai-openai-roundtrip',
    baseUrl: () => mock.openaiBaseUrl,
    streams: openAICompletionsApi,
    selectBy: 'marker',
  },
];

describe.each(scenarios)('pi-ai over $api', (scenario) => {
  it('completes a tool call round trip that passes every validation rule', async () => {
    const model = mockModel(scenario);
    const models = mockModels(scenario, model);
    const prompt = 'Read the file and tell me what it says.';
    const context: Context = {
      systemPrompt: SYSTEM_PROMPT,
      tools: [readFile],
      messages: [
        {
          role: 'user',
          content:
            scenario.selectBy === 'marker' ? `[[piarc-scenario:${scenario.id}]] ${prompt}` : prompt,
          timestamp: Date.now(),
        },
      ],
    };

    const first = await collect(models.stream(model, context));
    expect(first.message.stopReason).toBe('toolUse');
    expect(textOf(first.message)).toBe('I will read the file.');
    const toolCalls = first.message.content.filter(isToolCall);
    expect(toolCalls).toHaveLength(1);
    const [call] = toolCalls;
    if (call === undefined) {
      throw new Error('no tool call');
    }
    expect(call.name).toBe('read_file');
    expect(call.arguments).toEqual(ARGUMENTS);
    // The arguments reached the client as at least three deltas that rebuild the JSON.
    expect(first.toolCallDeltas.length).toBeGreaterThanOrEqual(3);
    expect(first.toolCallDeltas.join('')).toBe(ARGUMENTS_JSON);
    expect(first.message.usage.input).toBe(50);
    expect(first.message.usage.output).toBe(20);

    context.messages.push(first.message, {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
      timestamp: Date.now(),
    });
    const second = await collect(models.stream(model, context));
    expect(second.message.stopReason).toBe('stop');
    expect(textOf(second.message)).toBe('The file says hello.');

    const records = (await mock.records()).filter((record) => record.scenario === scenario.id);
    expect(records.map((record) => [record.stepIndex, record.outcome, record.violations])).toEqual([
      [0, 'streamed', []],
      [1, 'streamed', []],
    ]);
    const [, followUp] = records;
    if (followUp === undefined) {
      throw new Error('no follow-up request');
    }
    expect(answersToolCall(scenario.api, followUp, call.id)).toBe(true);
    for (const record of records) {
      // Test API key only: the key header is present (redacted in the log), and the
      // Anthropic request carries no bearer token, which is how OAuth would authenticate.
      if (scenario.api === 'anthropic-messages') {
        expect(record.headers['x-api-key']).toBe('<redacted>');
        expect(record.headers.authorization).toBeUndefined();
      } else {
        expect(record.headers.authorization).toBe('<redacted>');
      }
      expect(record.body).not.toContain(TEST_API_KEY);
    }
  });
});
