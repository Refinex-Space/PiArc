// Localization (architecture section 8.7, NFR-07): ICU MessageFormat (intl-messageformat, which
// interprets messages without `eval`, so the renderer's CSP stays strict), English and
// Simplified Chinese, one catalog shared by the main process (menus, dialogs, notifications)
// and the renderer. Every user-visible string of PiArc's own UI goes through `Translator`.
import { IntlMessageFormat } from 'intl-messageformat';

import { en, type MessageId } from './en.js';
import { zhCN } from './zh-CN.js';

export type { MessageId } from './en.js';

/** Supported locales. */
export const LOCALES = ['en', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageId, string>>>> = {
  en,
  'zh-CN': zhCN,
};

/** Values for a message's placeholders. */
export type MessageValues = Readonly<Record<string, string | number>>;

/** The locale for a preference: the first supported system language when `system`. */
export function resolveLocale(
  preference: 'system' | Locale,
  systemLanguages: readonly string[],
): Locale {
  if (preference !== 'system') {
    return preference;
  }
  for (const language of systemLanguages) {
    const lower = language.toLowerCase();
    if (lower.startsWith('zh')) {
      // Simplified Chinese is the only Chinese catalog; traditional scripts read it too.
      return 'zh-CN';
    }
    if (lower.startsWith('en')) {
      return 'en';
    }
  }
  return 'en';
}

/** Formats messages of one locale. Compiled messages are cached. */
export class Translator {
  readonly locale: Locale;
  private readonly compiled = new Map<MessageId, IntlMessageFormat>();

  constructor(locale: Locale) {
    this.locale = locale;
  }

  /** The message `id` with `values` filled in. */
  t(id: MessageId, values?: MessageValues): string {
    let format = this.compiled.get(id);
    if (format === undefined) {
      format = new IntlMessageFormat(CATALOGS[this.locale][id], this.locale);
      this.compiled.set(id, format);
    }
    const result = format.format(values);
    return typeof result === 'string' ? result : String(result);
  }
}

/** Whether `id` is a message id (for ids built at run time, such as category labels). */
export function isMessageId(id: string): id is MessageId {
  return Object.hasOwn(en, id);
}
