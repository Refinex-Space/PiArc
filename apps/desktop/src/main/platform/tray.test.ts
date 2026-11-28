import { describe, expect, it, vi } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { parseActivity, trayMenuTemplate, trayTitle, trayTooltip } from './tray.js';

vi.mock('electron', () => ({}));

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('tray', () => {
  it('reads the last activity of a batch and drops malformed sessions', () => {
    const activity = parseActivity(
      encode([
        { running: 1, awaiting: 0, awaitingSessions: [] },
        {
          running: 2,
          awaiting: 1,
          awaitingSessions: [{ id: 's1', title: '修复登录', workspace: '/w/repo' }, { title: 'x' }],
        },
      ]),
    );
    expect(activity).toEqual({
      running: 2,
      awaiting: 1,
      awaitingSessions: [{ id: 's1', title: '修复登录', workspace: '/w/repo' }],
    });
    expect(parseActivity(encode([{ running: -1, awaiting: 0 }]))).toBeUndefined();
    expect(parseActivity(new TextEncoder().encode('nope'))).toBeUndefined();
  });

  it('shows the counts as a title and a tooltip', () => {
    const t = new Translator('en');
    expect(trayTitle({ running: 0, awaiting: 0, awaitingSessions: [] })).toBe('');
    expect(trayTitle({ running: 3, awaiting: 0, awaitingSessions: [] })).toBe('▸3');
    expect(trayTitle({ running: 2, awaiting: 1, awaitingSessions: [] })).toBe('▸2 ?1');
    expect(trayTooltip({ running: 2, awaiting: 1, awaitingSessions: [] }, t)).toBe(
      'PiArc: 2 running, 1 waiting for approval',
    );
  });

  it('lists the waiting sessions between open and quit', () => {
    const t = new Translator('zh-CN');
    const opened: string[] = [];
    const actions = {
      open: () => opened.push('open'),
      newWindow: () => opened.push('window'),
      openSession: (id: string) => opened.push(id),
      quit: () => opened.push('quit'),
    };
    const items = trayMenuTemplate(
      {
        running: 1,
        awaiting: 1,
        awaitingSessions: [{ id: 's1', title: 'x'.repeat(80), workspace: '/w/项目' }],
      },
      t,
      actions,
      '未命名',
    );
    expect(items.map((i) => i.id ?? i.type)).toEqual([
      'tray.open',
      'tray.newWindow',
      'separator',
      'tray.awaiting',
      'tray.session.s1',
      'separator',
      'tray.quit',
    ]);
    const session = items[4];
    expect(session?.label).toHaveLength(60);
    expect(session?.sublabel).toBe('项目');
    session?.click?.({} as never, undefined, {});
    expect(opened).toEqual(['s1']);
    const empty = trayMenuTemplate(
      { running: 0, awaiting: 0, awaitingSessions: [] },
      t,
      actions,
      '',
    );
    expect(empty.find((i) => i.id === 'tray.noneAwaiting')?.enabled).toBe(false);
  });
});
