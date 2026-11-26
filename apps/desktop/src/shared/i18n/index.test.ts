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
            summary: 'npm test',
            cost: '$1.00',
            n: 1,
            current: 1,
            lines: 2,
            id: 'provider',
            model: 'chat',
            models: 'a, b',
            name: 'n',
            account: 'a@example.com',
            ms: '412',
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
            bytes: '21',
            pages: 3,
            path: 'sample.txt',
            seconds: 5,
            done: 1,
            total: 3,
            minutes: 1,
            hours: 0,
            value: 'v',
            kinds: 'memory',
            reliability: 'low',
            target: 'sample.txt',
            added: 1,
            removed: 2,
            cwd: '/workspace',
            elapsed: '5 s',
            sessions: 2,
            tasks: 1,
            running: 2,
            awaiting: 1,
            branch: 'main',
            workspace: '/w',
            code: 0,
            signal: 15,
            before: 2_000,
            after: 100,
            tool: 'Read',
            mode: 'Manual',
            attempt: 1,
            max: 3,
            queue: 'Mod+Enter',
            rule: 'Edit(src/**)',
            task: 'T25',
            line: 3,
            column: 25,
            action: 'Bold',
            url: 'https://example.com/',
            hosts: 'cdn.example.net',
            active: 1,
            matches: 3,
            origin: 'https://example.com',
            permission: 'use your camera',
            realm: 'Staging',
            error: 'ERR_CERT_DATE_INVALID',
            fingerprint: 'sha256/AAAA',
            row: 2,
            col: 3,
            effective: 1,
            overridden: 0,
            ignored: 2,
            issues: 0,
            limit: '5 MiB',
            event: 'Stop',
            percent: 75,
            tokens: 150_000,
            window: 200_000,
            threshold: 182_904,
            index: 1,
            input: 900,
            output: 120,
            field: 'memory',
            type: 'Explore',
            depth: 3,
            concurrent: 8,
            alias: 'fast',
            tier: 'fast',
            context: '200,000',
            efforts: 'low / high',
            tools: 'Read, Grep',
            transport: 'SSE',
            source: '/w/.mcp.json',
            host: 'example.com',
            by: '/w/.piarc/settings.json',
            hint: '[issue]',
            paths: 'src/**/*.rs',
            list: 'mods, bin',
            commit: 'abc1234',
            integrity: 'sha512-AAAA',
            version: '1.0.0',
            from: 'abc1234',
            to: 'def5678',
            side: 'new version',
            start: 11,
            end: 12,
            text: 'Fix the parser',
            kind: 'Run command?',
            status: 'Done',
            date: '2026-11-22',
            location: '/Library/Application Support/PiArc/managed-settings.json',
            panel: 'Terminal',
            number: 1,
            position: 2,
            detail: 'the Agent Host stopped',
            // The Git tool (ADR-0084, ADR-0085).
            remote: 'origin',
            remoteOid: 'abc1234',
            localOid: 'def5678',
            ahead: 2,
            behind: 1,
            base: 'main',
            upstream: 'origin/main',
            onto: 'main',
            step: 1,
            scope: 'All changes',
            short: 'abc1234',
            subject: 'feat: add login',
            stash: 'stash@{0}',
            group: 'Changes',
            pattern: 'release/*',
            language: 'English',
            leaving: 2,
            label: 'Before',
            pushed: 1,
            oid: 'abc1234',
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
