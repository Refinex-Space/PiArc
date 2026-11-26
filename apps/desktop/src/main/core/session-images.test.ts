import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { imageType, isBlobName, sessionImageResponse } = await import('./session-images.js');

describe('session images (ADR-0093)', () => {
  it('recognises PNG and JPEG by their bytes only', () => {
    expect(imageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(new TextEncoder().encode('<svg onload="x()">'))).toBeUndefined();
    expect(imageType(new Uint8Array())).toBeUndefined();
  });

  it('accepts only SHA-256 blob names', () => {
    expect(isBlobName('a'.repeat(64))).toBe(true);
    expect(isBlobName('A'.repeat(64))).toBe(false);
    expect(isBlobName('../'.padEnd(64, 'a'))).toBe(false);
    expect(isBlobName('a'.repeat(63))).toBe(false);
    expect(isBlobName(42)).toBe(false);
  });

  it('serves nothing that was not granted, and leaves other previews alone', () => {
    const missing = sessionImageResponse(
      new Request('piarc-document://session-images/00000000-0000-0000-0000-000000000000'),
    );
    expect(missing?.status).toBe(404);
    expect(sessionImageResponse(new Request('piarc-document://markdown-images/x'))).toBeUndefined();
  });
});
