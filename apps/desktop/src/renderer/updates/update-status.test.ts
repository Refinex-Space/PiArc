import { describe, expect, it } from 'vitest';

import {
  lastStatusOf,
  noticeOf,
  notesFor,
  parseUpdateStatus,
  percentOf,
  problemText,
} from './update-status.js';

const RELEASE = {
  version: '1.1.0',
  date: '2026-12-01',
  security: true,
  notes: { en: '### Fixed', 'zh-CN': '### 修复' },
  size: 1000,
  pageUrl: 'https://github.com/Refinex-Space/PiArc/releases/tag/v1.1.0',
};

describe('parseUpdateStatus', () => {
  it('reads a snapshot', () => {
    const status = parseUpdateStatus(
      JSON.stringify({
        state: 'downloading',
        current: '1.0.0',
        checkedAt: 5,
        release: RELEASE,
        progress: { received: 250, total: 1000 },
      }),
    );
    expect(status).toEqual({
      state: 'downloading',
      current: '1.0.0',
      checkedAt: 5,
      release: RELEASE,
      progress: { received: 250, total: 1000 },
    });
  });

  it('drops what it does not trust', () => {
    expect(parseUpdateStatus('not json')).toBeUndefined();
    expect(parseUpdateStatus({ state: 'exploded', current: '1' })).toBeUndefined();
    const status = parseUpdateStatus({
      state: 'available',
      current: '1.0.0',
      unavailable: 'whatever',
      release: { ...RELEASE, pageUrl: 'javascript:alert(1)', size: -4, notes: { en: 7 } },
      progress: { received: 'a', total: Number.NaN },
    });
    expect(status?.unavailable).toBeUndefined();
    expect(status?.release?.pageUrl).toBe('');
    expect(status?.release?.size).toBe(0);
    expect(status?.release?.notes).toEqual({});
    expect(status?.progress).toEqual({ received: 0, total: 0 });
  });

  it('takes the last snapshot of a batch', () => {
    const batch = new TextEncoder().encode(
      JSON.stringify([
        { state: 'checking', current: '1.0.0' },
        { state: 'upToDate', current: '1.0.0', checkedAt: 9 },
      ]),
    );
    expect(lastStatusOf(batch)?.state).toBe('upToDate');
    expect(lastStatusOf(new TextEncoder().encode('{}'))).toBeUndefined();
  });
});

describe('words for a status', () => {
  it('picks the notes of the app language, English otherwise', () => {
    expect(notesFor(RELEASE, 'zh-CN')).toBe('### 修复');
    expect(notesFor({ ...RELEASE, notes: { en: 'Only English' } }, 'zh-CN')).toBe('Only English');
  });

  it('maps problem codes to localized reasons', () => {
    expect(problemText({ code: 'proxy', message: '' })).toBe('about.problem.proxy');
    expect(problemText({ code: 'integrity', message: '' })).toBe('about.problem.integrity');
    expect(problemText({ code: 'novel', message: '' })).toBe('about.problem.other');
    expect(problemText(null)).toBe('about.problem.other');
  });

  it('shows the sidebar notice only while a newer release is in play', () => {
    const base = { current: '1.0.0', release: RELEASE };
    expect(noticeOf({ ...base, state: 'available' })).toEqual({
      version: '1.1.0',
      ready: false,
      security: true,
    });
    expect(noticeOf({ ...base, state: 'ready' })?.ready).toBe(true);
    expect(noticeOf({ ...base, state: 'failed' })).toBeUndefined();
    expect(noticeOf({ current: '1.0.0', state: 'upToDate' })).toBeUndefined();
    expect(noticeOf(undefined)).toBeUndefined();
  });

  it('rounds progress down and never passes 100', () => {
    const at = (received: number, total: number) =>
      percentOf({ state: 'downloading', current: '1', progress: { received, total } });
    expect(at(999, 1000)).toBe(99);
    expect(at(2000, 1000)).toBe(100);
    expect(at(5, 0)).toBe(0);
  });
});
