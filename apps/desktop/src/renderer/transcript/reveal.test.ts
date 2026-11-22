import { describe, expect, it } from 'vitest';

import { revealBidi } from './reveal.js';

describe('bidirectional controls on approval cards and diffs', () => {
  it('THR-01 shows every bidirectional control as a visible marker, in place', () => {
    // Displayed as-is, U+202E would make "user… run(rm …)" read in another order.
    expect(revealBidi('access = "user‮ ⁦// admin⁩ ⁦"; run‭(x)')).toBe(
      'access = "user[U+202E] [U+2066]// admin[U+2069] [U+2066]"; run[U+202D](x)',
    );
    expect(revealBidi('notes/ ‮gnp.md ‎‏؜‪‫‬⁧⁨')).toBe(
      'notes/ [U+202E]gnp.md [U+200E][U+200F][U+061C][U+202A][U+202B][U+202C][U+2067][U+2068]',
    );
  });

  it('leaves other text, right-to-left scripts included, untouched', () => {
    for (const text of ['rm -rf build', 'שלום עולם', 'مرحبا', '中文 路径', '']) {
      expect(revealBidi(text)).toBe(text);
    }
  });
});
