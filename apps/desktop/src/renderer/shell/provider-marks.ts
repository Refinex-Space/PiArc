// Which brand mark identifies a model provider (ADR-0107). Built-in and sign-in providers match
// by id; a custom endpoint by its base URL's host; otherwise a word of its id or name may name a
// known brand (a custom provider called "deepseek-test"). No match draws a neutral glyph.
import type { ProviderMarkName } from './provider-marks.generated.js';

/** Pi's provider ids (and their regional or plan variants, `<id>-…`) → mark. */
const BY_ID: readonly (readonly [string, ProviderMarkName])[] = [
  ['openai-codex', 'codex'],
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['amazon-bedrock', 'bedrock'],
  ['ant-ling', 'ling'],
  ['azure', 'azure'],
  ['baseten', 'baseten'],
  ['cerebras', 'cerebras'],
  ['cloudflare-workers-ai', 'workersai'],
  ['cloudflare', 'cloudflare'],
  ['deepseek', 'deepseek'],
  ['fireworks', 'fireworks'],
  ['github-copilot', 'githubcopilot'],
  ['google-vertex', 'vertexai'],
  ['google', 'google'],
  ['groq', 'groq'],
  ['huggingface', 'huggingface'],
  ['kimi', 'kimi'],
  ['moonshotai', 'moonshot'],
  ['meta', 'meta'],
  ['minimax', 'minimax'],
  ['mistral', 'mistral'],
  ['nvidia', 'nvidia'],
  ['opencode', 'opencode'],
  ['openrouter', 'openrouter'],
  ['qwen', 'qwen'],
  ['radius', 'pi'],
  ['together', 'together'],
  ['typesafe', 'typesafeai'],
  ['vercel', 'vercel'],
  ['xai', 'xai'],
  ['xiaomi', 'xiaomimimo'],
  ['zai-coding-cn', 'zhipu'],
  ['zai', 'zai'],
];

/** API hosts (the domain or any subdomain of it) → mark; the more specific entry first. */
const BY_HOST: readonly (readonly [string, ProviderMarkName])[] = [
  ['openai.azure.com', 'azure'],
  ['azure.com', 'azure'],
  ['openai.com', 'openai'],
  ['chatgpt.com', 'codex'],
  ['anthropic.com', 'anthropic'],
  ['ant-ling.com', 'ling'],
  ['baseten.co', 'baseten'],
  ['cerebras.ai', 'cerebras'],
  ['cloudflare.com', 'cloudflare'],
  ['deepseek.com', 'deepseek'],
  ['fireworks.ai', 'fireworks'],
  ['githubcopilot.com', 'githubcopilot'],
  ['aiplatform.googleapis.com', 'vertexai'],
  ['generativelanguage.googleapis.com', 'google'],
  ['groq.com', 'groq'],
  ['huggingface.co', 'huggingface'],
  ['kimi.com', 'kimi'],
  ['moonshot.cn', 'moonshot'],
  ['moonshot.ai', 'moonshot'],
  ['meta.ai', 'meta'],
  ['minimax.io', 'minimax'],
  ['minimaxi.com', 'minimax'],
  ['mistral.ai', 'mistral'],
  ['nvidia.com', 'nvidia'],
  ['opencode.ai', 'opencode'],
  ['openrouter.ai', 'openrouter'],
  ['aliyuncs.com', 'qwen'],
  ['pi.dev', 'pi'],
  ['together.ai', 'together'],
  ['together.xyz', 'together'],
  ['typesafe.ai', 'typesafeai'],
  ['vercel.sh', 'vercel'],
  ['x.ai', 'xai'],
  ['xiaomimimo.com', 'xiaomimimo'],
  ['z.ai', 'zai'],
  ['bigmodel.cn', 'zhipu'],
];

/** Words in a custom provider's id or name that name a brand. */
const BY_WORD: ReadonlyMap<string, ProviderMarkName> = new Map(
  Object.entries({
    openai: 'openai',
    codex: 'codex',
    anthropic: 'anthropic',
    claude: 'anthropic',
    bedrock: 'bedrock',
    azure: 'azure',
    baseten: 'baseten',
    cerebras: 'cerebras',
    cloudflare: 'cloudflare',
    deepseek: 'deepseek',
    fireworks: 'fireworks',
    copilot: 'githubcopilot',
    vertex: 'vertexai',
    gemini: 'google',
    google: 'google',
    groq: 'groq',
    huggingface: 'huggingface',
    kimi: 'kimi',
    moonshot: 'moonshot',
    llama: 'meta',
    minimax: 'minimax',
    mistral: 'mistral',
    nvidia: 'nvidia',
    opencode: 'opencode',
    openrouter: 'openrouter',
    qwen: 'qwen',
    dashscope: 'qwen',
    bailian: 'qwen',
    together: 'together',
    vercel: 'vercel',
    grok: 'xai',
    xai: 'xai',
    xiaomi: 'xiaomimimo',
    mimo: 'xiaomimimo',
    zhipu: 'zhipu',
    glm: 'zhipu',
    bigmodel: 'zhipu',
  } satisfies Record<string, ProviderMarkName>),
);

export interface ProviderIdentity {
  readonly id: string;
  readonly name?: string | undefined;
  /** A custom endpoint's base URL. */
  readonly baseUrl?: string | undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The mark that identifies `provider`, or `undefined` when none does. */
export function providerMarkOf(provider: ProviderIdentity): ProviderMarkName | undefined {
  const id = provider.id.toLowerCase();
  const byId = BY_ID.find(([key]) => id === key || id.startsWith(`${key}-`));
  if (byId) return byId[1];
  const host = provider.baseUrl === undefined ? undefined : hostOf(provider.baseUrl);
  if (host !== undefined) {
    const byHost = BY_HOST.find(([key]) => host === key || host.endsWith(`.${key}`));
    if (byHost) return byHost[1];
  }
  const words = `${provider.id} ${provider.name ?? ''}`.toLowerCase().split(/[^a-z0-9]+/u);
  for (const word of words) {
    const mark = BY_WORD.get(word);
    if (mark !== undefined) return mark;
  }
  return undefined;
}
