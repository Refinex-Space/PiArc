import { describe, expect, it } from 'vitest';
import { canReuse } from './verify.mjs';

describe('verify --baseline', () => {
  it('reuses the last full pass only when docs/ alone changed since', () => {
    expect(canReuse([])).toBe(true);
    expect(canReuse(['docs/adr/README.md', 'docs/architecture/ARCHITECTURE.md'])).toBe(true);
    expect(canReuse(['docs/adr/README.md', 'crates/piarc-web/src/lib.rs'])).toBe(false);
    expect(canReuse(['AGENTS.md'])).toBe(false);
  });
});
