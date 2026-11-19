// Context usage by category (architecture section 6.6.5, T27, ADR-0043 rule 8). Before every
// model request (Pi's `context_with_system`, which sees the leading system message with the
// prompt and the tool declarations) the context is estimated by category with tokens.ts. When
// the response reports its input (`input + cacheRead + cacheWrite`), that is the total and the
// difference to the estimate is "unclassified"; an estimate above the report is scaled down to
// it. `session/usage` reports it after each response and each compaction;
// `session/getContextUsage` returns the latest.
import { getCurrentTools, type SystemMessage } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type {
  AutoCompactState,
  AutoCompactStop,
  ContextCategories,
  ContextUsage,
} from '@piarc/protocol';

import { isObject } from '../runtime/items.js';
import type { ProjectionSink } from '../runtime/projector.js';
import { REMINDER_ENTRY, reminderRecords } from './reminders.js';
import { contentChars, tokensOfChars } from './tokens.js';

type Category = Exclude<keyof ContextCategories, 'unclassified'>;

const CATEGORIES: readonly Category[] = [
  'systemPrompt',
  'tools',
  'mcpTools',
  'memory',
  'skills',
  'conversation',
  'toolResults',
];

/** System prompt sections that count elsewhere: memory (T22) and the skills index (T37). */
const SECTION_CATEGORY: Readonly<Record<string, Category>> = {
  project_context: 'memory',
  skills: 'skills',
};

function emptyChars(): Record<Category, number> {
  return {
    systemPrompt: 0,
    tools: 0,
    mcpTools: 0,
    memory: 0,
    skills: 0,
    conversation: 0,
    toolResults: 0,
  };
}

function systemChars(text: string, chars: Record<Category, number>): void {
  let rest = text.length;
  for (const [name, category] of Object.entries(SECTION_CATEGORY)) {
    const start = text.indexOf(`<${name}>`);
    const close = `</${name}>`;
    const end = start === -1 ? -1 : text.indexOf(close, start);
    if (end === -1) continue;
    const length = end + close.length - start;
    chars[category] += length;
    rest -= length;
  }
  chars.systemPrompt += rest;
}

function toolChars(tool: unknown): number {
  if (!isObject(tool)) return 0;
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }).length;
}

/** What the request's system prompt and tool definitions are. Pi 1.5.2 replaces the
 * transcript's system messages with the forced (frozen) prompt after `context_with_system`, so
 * the frozen text is what the provider gets; the tools are the transcript's current loadout. */
export interface Loadout {
  readonly system?: string;
  readonly tools?: readonly unknown[];
}

/** The current tool loadout declared by the system messages of `messages`. */
export function currentTools(messages: readonly unknown[]): readonly unknown[] {
  const system = messages.filter(
    (message): message is SystemMessage => isObject(message) && message.role === 'system',
  );
  return system.length === 0 ? [] : getCurrentTools(system);
}

/** The context of `messages` by category, in tokens (`unclassified` is 0). Tool names in
 * `mcpTools` count as MCP tools. */
export function estimateCategories(
  messages: readonly unknown[],
  mcpTools: ReadonlySet<string>,
  loadout: Loadout = {},
): ContextCategories {
  const chars = emptyChars();
  const systemTexts: string[] = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    switch (message.role) {
      case 'system': {
        if (typeof message.content === 'string') systemTexts.push(message.content);
        else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (isObject(block) && typeof block.text === 'string') systemTexts.push(block.text);
          }
        }
        if (isObject(message.sections)) {
          for (const section of Object.values(message.sections)) {
            if (typeof section === 'string') systemTexts.push(section);
          }
        }
        break;
      }
      case 'user':
      case 'assistant':
        chars.conversation += contentChars(message.content);
        break;
      case 'toolResult':
        chars.toolResults += contentChars(message.content);
        break;
      case 'bashExecution':
        chars.toolResults +=
          (typeof message.command === 'string' ? message.command.length : 0) +
          (typeof message.output === 'string' ? message.output.length : 0);
        break;
      case 'compactionSummary':
      case 'branchSummary':
        chars.conversation += typeof message.summary === 'string' ? message.summary.length : 0;
        break;
      case 'custom': {
        const total = contentChars(message.content);
        if (message.customType === REMINDER_ENTRY) {
          let counted = 0;
          for (const record of reminderRecords(message.details)) {
            chars[record.category] += record.chars;
            counted += record.chars;
          }
          chars.conversation += Math.max(0, total - counted);
        } else {
          // Before T27 memory went as `piarc.memory` messages.
          chars[message.customType === 'piarc.memory' ? 'memory' : 'conversation'] += total;
        }
        break;
      }
      default:
        break;
    }
  }
  systemChars(loadout.system ?? systemTexts.join(''), chars);
  for (const tool of loadout.tools ?? currentTools(messages)) {
    const name = isObject(tool) && typeof tool.name === 'string' ? tool.name : '';
    chars[mcpTools.has(name) ? 'mcpTools' : 'tools'] += toolChars(tool);
  }
  const categories: ContextCategories = { ...chars, unclassified: 0 };
  for (const category of CATEGORIES) categories[category] = tokensOfChars(chars[category]);
  return categories;
}

/** The sum of `categories`. */
export function totalOf(categories: ContextCategories): number {
  return CATEGORIES.reduce((sum, category) => sum + categories[category], categories.unclassified);
}

/** `estimate` with `reported` as the total: the rest is unclassified; an estimate above it is
 * scaled down (largest remainders) and nothing is unclassified. */
export function withReportedTotal(
  estimate: ContextCategories,
  reported: number,
): ContextCategories {
  const sum = CATEGORIES.reduce((total, category) => total + estimate[category], 0);
  if (sum <= reported) return { ...estimate, unclassified: reported - sum };
  const scaled: ContextCategories = { ...estimate, unclassified: 0 };
  const remainders: { category: Category; fraction: number }[] = [];
  let assigned = 0;
  for (const category of CATEGORIES) {
    const exact = (estimate[category] * reported) / sum;
    scaled[category] = Math.floor(exact);
    assigned += scaled[category];
    remainders.push({ category, fraction: exact - Math.floor(exact) });
  }
  remainders.sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < reported - assigned; i++) {
    const next = remainders[i % remainders.length];
    if (next !== undefined) scaled[next.category] += 1;
  }
  return scaled;
}

/** What the usage is measured against, from the compaction settings. */
export interface UsageLimits {
  readonly contextWindow: number;
  readonly autoCompactThreshold: number;
  readonly autoCompact: AutoCompactState;
  readonly autoCompactStopped?: AutoCompactStop;
}

export interface ContextUsageOptions {
  readonly sink: ProjectionSink;
  readonly limits: () => UsageLimits;
  /** Names of the session's MCP tools. */
  readonly mcpTools: () => ReadonlySet<string>;
  /** The conversation as the next request would send it. */
  readonly messages: () => readonly unknown[];
  /** The frozen system prompt the provider gets, once assembled. */
  readonly system: () => string | undefined;
  /** The session's active tools, for a transcript that declares none yet. */
  readonly tools: () => readonly unknown[];
}

/** One session's context usage. */
export class ContextUsageTracker {
  readonly #o: ContextUsageOptions;
  /** The estimate of the latest request's context. */
  #request: ContextCategories | undefined;
  #last: ContextUsage | undefined;

  constructor(options: ContextUsageOptions) {
    this.#o = options;
  }

  #usage(categories: ContextCategories, source: ContextUsage['source']): ContextUsage {
    const limits = this.#o.limits();
    return {
      tokens: totalOf(categories),
      contextWindow: limits.contextWindow,
      autoCompactThreshold: Math.max(0, limits.autoCompactThreshold),
      categories,
      source,
      autoCompact: limits.autoCompact,
      ...(limits.autoCompactStopped === undefined
        ? {}
        : { autoCompactStopped: limits.autoCompactStopped }),
    };
  }

  #publish(usage: ContextUsage): void {
    this.#last = usage;
    this.#o.sink.event('session/usage', { usage });
  }

  /** The estimate of the context as it is now. */
  estimate(): ContextUsage {
    return this.#usage(this.#estimate(this.#o.messages()), 'estimate');
  }

  #estimate(messages: readonly unknown[]): ContextCategories {
    const system = this.#o.system();
    const declared = currentTools(messages);
    return estimateCategories(messages, this.#o.mcpTools(), {
      ...(system === undefined ? {} : { system }),
      tools: declared.length > 0 ? declared : this.#o.tools(),
    });
  }

  /** The latest usage, or the estimate when no request was made yet. */
  current(): ContextUsage {
    return this.#last ?? this.estimate();
  }

  /** A model response ended: its reported input is the total of the request's context. */
  responded(message: unknown): void {
    const categories = this.#request;
    if (categories === undefined || !isObject(message) || !isObject(message.usage)) return;
    const { input, cacheRead, cacheWrite } = message.usage;
    const reported = [input, cacheRead, cacheWrite].reduce<number>(
      (sum, value) => sum + (typeof value === 'number' && value > 0 ? value : 0),
      0,
    );
    this.#publish(
      reported > 0
        ? this.#usage(withReportedTotal(categories, reported), 'provider')
        : this.#usage(categories, 'estimate'),
    );
  }

  /** After a compaction: the estimate of the compacted context. */
  compacted(): ContextUsage {
    const usage = this.estimate();
    this.#publish(usage);
    return usage;
  }

  extension: ExtensionFactory = (pi) => {
    pi.on('context_with_system', (event) => {
      this.#request = this.#estimate(event.messages);
      return undefined;
    });
  };
}
