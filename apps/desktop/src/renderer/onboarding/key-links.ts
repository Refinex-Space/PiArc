// Where each provider hands out API keys (ADR-0110), opened by "Get a key" through the main
// process's link confirmation. The table is fixed here: never taken from Pi's catalog or an
// endpoint's answer, so a page cannot steer the user to another site. Checked against each
// vendor's documentation on 2026-11-28.
const KEY_PAGES: Readonly<Record<string, string>> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  // Pi's two GLM ids are the Coding Plan endpoints; a plan key comes from the plan's page.
  zai: 'https://z.ai/manage-apikey/apikey-list',
  'zai-coding-cn': 'https://bigmodel.cn/coding-plan/personal/overview',
  moonshotai: 'https://platform.kimi.ai/console/api-keys',
  'moonshotai-cn': 'https://platform.kimi.com/console/api-keys',
  'kimi-coding': 'https://www.kimi.com/code/console',
  'qwen-token-plan': 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
  'qwen-token-plan-individual':
    'https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/token-plan/personal',
  'qwen-token-plan-cn': 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
  'qwen-token-plan-individual-cn':
    'https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal',
  minimax: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  'minimax-cn': 'https://platform.minimax.cn/user-center/basic-information/interface-key',
  // Pay-as-you-go keys and Token Plan keys are different kinds on MiMo.
  xiaomi: 'https://platform.xiaomimimo.com/#/console/api-keys',
  'xiaomi-token-plan-cn': 'https://platform.xiaomimimo.com/#/console/plan-manage',
  'xiaomi-token-plan-sgp': 'https://platform.xiaomimimo.com/#/console/plan-manage',
  'xiaomi-token-plan-ams': 'https://platform.xiaomimimo.com/#/console/plan-manage',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://platform.claude.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
};

/** The key page of built-in provider `id`, when the table has one. */
export function keyPageOf(id: string): string | undefined {
  return Object.hasOwn(KEY_PAGES, id) ? KEY_PAGES[id] : undefined;
}

/** Every listed page (for the tests). */
export function keyPages(): readonly (readonly [string, string])[] {
  return Object.entries(KEY_PAGES);
}
