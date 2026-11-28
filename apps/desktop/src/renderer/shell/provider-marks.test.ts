import { describe, expect, it } from 'vitest';

import { PROVIDER_MARKS } from './provider-marks.generated.js';
import { providerMarkOf } from './provider-marks.js';

// Pi 1.5.2's built-in and sign-in provider ids (node_modules/@earendil-works/pi-ai/dist/
// providers/data/ and auth/oauth/).
const PI_PROVIDERS: Record<string, string> = {
  'amazon-bedrock': 'bedrock',
  'ant-ling': 'ling',
  anthropic: 'anthropic',
  azure: 'azure',
  'azure-openai-responses': 'azure',
  baseten: 'baseten',
  cerebras: 'cerebras',
  'cloudflare-ai-gateway': 'cloudflare',
  'cloudflare-workers-ai': 'workersai',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  'github-copilot': 'githubcopilot',
  'google-vertex': 'vertexai',
  google: 'google',
  groq: 'groq',
  huggingface: 'huggingface',
  'kimi-coding': 'kimi',
  meta: 'meta',
  'minimax-cn': 'minimax',
  minimax: 'minimax',
  mistral: 'mistral',
  'moonshotai-cn': 'moonshot',
  moonshotai: 'moonshot',
  nvidia: 'nvidia',
  'openai-codex': 'codex',
  openai: 'openai',
  'opencode-go': 'opencode',
  opencode: 'opencode',
  openrouter: 'openrouter',
  'qwen-token-plan-cn': 'qwen',
  'qwen-token-plan-individual': 'qwen',
  radius: 'pi',
  together: 'together',
  typesafe: 'typesafeai',
  'vercel-ai-gateway': 'vercel',
  xai: 'xai',
  'xiaomi-token-plan-sgp': 'xiaomimimo',
  xiaomi: 'xiaomimimo',
  'zai-coding-cn': 'zhipu',
  zai: 'zai',
};

describe('providerMarkOf', () => {
  it('names a mark for every Pi provider', () => {
    for (const [id, mark] of Object.entries(PI_PROVIDERS)) {
      expect(providerMarkOf({ id }), id).toBe(mark);
      expect(mark in PROVIDER_MARKS, mark).toBe(true);
    }
  });

  it('matches a whole id segment, not any prefix', () => {
    expect(providerMarkOf({ id: 'metabase' })).toBeUndefined();
    expect(providerMarkOf({ id: 'openaix' })).toBeUndefined();
  });

  it("identifies a custom endpoint by its base URL's host", () => {
    expect(providerMarkOf({ id: 'work', baseUrl: 'https://api.deepseek.com/v1' })).toBe('deepseek');
    expect(providerMarkOf({ id: 'p', baseUrl: 'https://dashscope.aliyuncs.com/compatible' })).toBe(
      'qwen',
    );
    expect(providerMarkOf({ id: 'p', baseUrl: 'https://my.openai.azure.com/openai' })).toBe(
      'azure',
    );
    expect(providerMarkOf({ id: 'p', baseUrl: 'https://open.bigmodel.cn/api' })).toBe('zhipu');
    // A look-alike domain is not the brand.
    expect(providerMarkOf({ id: 'p', baseUrl: 'https://notdeepseek.com/v1' })).toBeUndefined();
    expect(providerMarkOf({ id: 'p', baseUrl: 'not a url' })).toBeUndefined();
  });

  it('falls back to a brand named by a word of the id or name', () => {
    expect(providerMarkOf({ id: 'deepseek-test' })).toBe('deepseek');
    expect(providerMarkOf({ id: 'p1', name: 'My Qwen proxy' })).toBe('qwen');
    expect(providerMarkOf({ id: 'gateway', baseUrl: 'http://localhost:4000' })).toBeUndefined();
    // Object prototype keys are not words of the table.
    expect(providerMarkOf({ id: 'constructor' })).toBeUndefined();
    expect(providerMarkOf({ id: 'to-string', name: '__proto__' })).toBeUndefined();
  });

  it('prefers the id over the host and the host over words', () => {
    expect(providerMarkOf({ id: 'openrouter', baseUrl: 'https://api.deepseek.com' })).toBe(
      'openrouter',
    );
    expect(providerMarkOf({ id: 'qwen-proxy', baseUrl: 'https://api.deepseek.com' })).toBe('qwen');
    expect(providerMarkOf({ id: 'claude-relay', baseUrl: 'https://api.deepseek.com' })).toBe(
      'deepseek',
    );
  });
});
