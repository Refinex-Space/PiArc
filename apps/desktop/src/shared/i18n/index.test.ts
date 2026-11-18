import { describe, expect, it } from 'vitest';

import { en } from './en.js';
import { LOCALES, Translator, isMessageId, resolveLocale } from './index.js';
import { zhCN } from './zh-CN.js';

describe('i18n', () => {
  it('formats placeholders and plurals in both locales', () => {
    const english = new Translator('en');
    expect(english.t('workspace.count', { count: 1 })).toBe('1 session');
    expect(english.t('workspace.count', { count: 3 })).toBe('3 sessions');
    expect(english.t('dialog.delete.message', { title: 'Plan' })).toBe('Delete “Plan”?');
    const chinese = new Translator('zh-CN');
    expect(chinese.t('workspace.count', { count: 3 })).toBe('3 个会话');
    expect(chinese.t('command.session.new')).toBe('新建会话');
  });

  it('every catalog has every message and every message parses', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const locale of LOCALES) {
      const translator = new Translator(locale);
      for (const id of Object.keys(en)) {
        if (!isMessageId(id)) {
          throw new Error(id);
        }
        // Every placeholder gets a value, so a malformed message or a missing one fails here.
        expect(() =>
          translator.t(id, {
            title: 't',
            id: 'provider',
            model: 'chat',
            name: 'n',
            query: 'q',
            count: 2,
            reason: 'r',
            message: 'm',
            files: 'f',
            decision: 'd',
            command: 'c',
            key: 'k',
            modifiers: 'm',
            size: '5 KiB',
            pages: 3,
            path: 'sample.txt',
            seconds: 5,
            minutes: 1,
            target: 'sample.txt',
            added: 1,
            removed: 2,
            cwd: '/workspace',
            elapsed: '5 s',
            code: 0,
            signal: 15,
            before: 2_000,
            after: 100,
            tool: 'Read',
            mode: 'Manual',
            attempt: 1,
            max: 3,
            queue: 'Mod+Enter',
            limit: '5 MiB',
          }),
        ).not.toThrow();
      }
    }
  });

  it('resolves the system language', () => {
    expect(resolveLocale('system', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB'])).toBe('en');
    expect(resolveLocale('system', ['fr-FR'])).toBe('en');
    expect(resolveLocale('en', ['zh-CN'])).toBe('en');
  });
});
