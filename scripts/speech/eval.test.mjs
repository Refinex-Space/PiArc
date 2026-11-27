import { describe, expect, it } from 'vitest';

import {
  editDistance,
  errors,
  hasTerm,
  kept,
  normalize,
  repeats,
  score,
  swallowedLast,
  tokens,
  wav,
} from './eval.mjs';

describe('appendix B normalization', () => {
  it('folds width and case and drops punctuation; versions and paths split', () => {
    expect(normalize('Ｈｅｌｌｏ，ＷＯＲＬＤ！')).toBe('hello world');
    expect(tokens('检查 src/main/core 的接口，保留 v1.2.3。')).toEqual([
      '检',
      '查',
      'src',
      'main',
      'core',
      '的',
      '接',
      '口',
      '保',
      '留',
      'v1',
      '2',
      '3',
    ]);
    expect(tokens('Use React 和 Rust')).toEqual(['use', 'react', '和', 'rust']);
  });

  it('counts token edits', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(editDistance([], ['a'])).toBe(1);
    expect(errors('今天下午三点开会', '今天下午三点开会')).toEqual({ errors: 0, length: 8 });
    expect(errors('不要删除数据库', '要删除数据库').errors).toBe(1);
  });
});

describe('special checks', () => {
  it('finds terms ignoring case and spaces', () => {
    expect(hasTerm('帮我用 claude code 分析', 'Claude Code')).toBe(true);
    expect(hasTerm('接入 napi rs', 'NAPI-RS')).toBe(false);
    expect(hasTerm('mybatis plus', 'MyBatis')).toBe(true);
  });

  it('counts each expected occurrence once', () => {
    expect(kept('不要删除，不要修改', ['不要', '不要'])).toBe(2);
    expect(kept('要删除，不要修改', ['不要', '不要'])).toBe(1);
  });

  it('notices a swallowed last word and invented repeats', () => {
    expect(swallowedLast('最后观察日志', '最后观察')).toBe(true);
    expect(swallowedLast('最后观察日志', '最后观察日志。')).toBe(false);
    expect(repeats('always always', 'always always always')).toBe(1);
    expect(repeats('the day', 'the day')).toBe(0);
  });

  it('scores a pass by kind with dictionary terms apart', () => {
    const items = [
      { id: 'a', kind: 'zh', voice: '', locale: '', text: '不要删除', negations: ['不要'] },
      {
        id: 'b',
        kind: 'mix',
        voice: '',
        locale: '',
        text: '用 Redis 和 Foo',
        terms: ['Redis', 'Foo'],
      },
    ];
    const result = score(
      items,
      new Map([
        ['a', '不要删除'],
        ['b', '用 redis 和'],
      ]),
      ['Redis'],
    );
    expect(result.cer).toBe(0);
    expect(result.mer).toBeCloseTo(1 / 4);
    expect(result.termRecall).toBe(1);
    expect(result.termRecallOther).toBe(0);
    expect(result.special.negations).toEqual({ kept: 1, total: 1 });
  });
});

describe('wav', () => {
  it('writes a 16 kHz mono PCM header and clamps samples', () => {
    const bytes = wav([0, 1, -1, 2]);
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.readUInt32LE(24)).toBe(16000);
    expect(bytes.readUInt32LE(40)).toBe(8);
    expect(bytes.readInt16LE(46)).toBe(32767);
    expect(bytes.readInt16LE(50)).toBe(32767);
  });
});
