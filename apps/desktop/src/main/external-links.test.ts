import { describe, expect, it } from 'vitest';

import {
  MAX_EXTERNAL_URL_LENGTH,
  openExternalLink,
  parseExternalUrl,
  type ExternalLinkPort,
} from './external-links.js';

function recordingPort(confirmAnswer: boolean) {
  const calls: string[] = [];
  const port: ExternalLinkPort = {
    confirm: (url) => {
      calls.push(`confirm ${url}`);
      return Promise.resolve(confirmAnswer);
    },
    open: (url) => {
      calls.push(`open ${url}`);
      return Promise.resolve();
    },
  };
  return { port, calls };
}

describe('parseExternalUrl', () => {
  it('accepts https, http and mailto URLs', () => {
    expect(parseExternalUrl('https://example.com/a?b=c')?.href).toBe('https://example.com/a?b=c');
    expect(parseExternalUrl('http://example.com')?.href).toBe('http://example.com/');
    expect(parseExternalUrl('mailto:someone@example.com')?.protocol).toBe('mailto:');
  });

  it('rejects every other scheme', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'app://piarc/index.html',
      'piarc://open',
      'ftp://example.com',
      'smb://server/share',
    ]) {
      expect(parseExternalUrl(value), value).toBeNull();
    }
  });

  it('rejects non-strings, malformed and overlong input', () => {
    for (const value of [undefined, null, 42, {}, ['https://example.com'], '', 'example.com']) {
      expect(parseExternalUrl(value)).toBeNull();
    }
    expect(
      parseExternalUrl(`https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`),
    ).toBeNull();
  });

  it('shows internationalised hosts in punycode', () => {
    expect(parseExternalUrl('https://exаmple.com/')?.href).toBe('https://xn--exmple-4nf.com/');
  });
});

describe('openExternalLink', () => {
  it('opens the normalised URL only after the user confirms', async () => {
    const { port, calls } = recordingPort(true);
    await expect(openExternalLink('https://example.com', port)).resolves.toBe(true);
    expect(calls).toEqual(['confirm https://example.com/', 'open https://example.com/']);
  });

  it('does not open the link when the user cancels', async () => {
    const { port, calls } = recordingPort(false);
    await expect(openExternalLink('https://example.com', port)).resolves.toBe(false);
    expect(calls).toEqual(['confirm https://example.com/']);
  });

  it('rejects disallowed URLs without asking the user', async () => {
    const { port, calls } = recordingPort(true);
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 42]) {
      await expect(openExternalLink(value, port)).resolves.toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
