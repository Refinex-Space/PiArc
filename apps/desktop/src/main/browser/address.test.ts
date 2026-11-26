import { describe, expect, it } from 'vitest';

import { local, parseAddress, searchUrl } from './address.js';

describe('parseAddress', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a?b=1#c', 'http://example.com/a?b=1#c'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path'],
    ['example.com', 'https://example.com/'],
    ['docs.rs/serde', 'https://docs.rs/serde'],
    ['sub.example.co.uk/x?y', 'https://sub.example.co.uk/x?y'],
    ['例子.测试', 'https://xn--fsqu00a.xn--0zwm56d/'],
    ['localhost', 'http://localhost/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['localhost:3000/app?x=1', 'http://localhost:3000/app?x=1'],
    [':8080', 'http://localhost:8080/'],
    [':8080/health', 'http://localhost:8080/health'],
    ['127.0.0.1:4000', 'http://127.0.0.1:4000/'],
    ['127.0.0.1', 'http://127.0.0.1/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['web.localhost:5173', 'http://web.localhost:5173/'],
    ['myapp.test', 'http://myapp.test/'],
    ['printer.local', 'http://printer.local/'],
    ['192.168.1.20:8000', 'http://192.168.1.20:8000/'],
    ['10.0.0.5', 'http://10.0.0.5/'],
    ['172.20.1.1', 'http://172.20.1.1/'],
    ['8.8.8.8', 'https://8.8.8.8/'],
    ['example.com:8443', 'https://example.com:8443/'],
    ['about:blank', 'about:blank'],
    ['  https://example.com  ', 'https://example.com/'],
  ])('%s opens %s', (input, url) => {
    expect(parseAddress(input)).toEqual({ kind: 'url', url });
  });

  it.each([
    ['how to center a div', 'how to center a div'],
    ['react', 'react'],
    ['what is 1+1', 'what is 1+1'],
    ['localhost is down', 'localhost is down'],
    ['C# tutorial', 'C# tutorial'],
  ])('%s is a search', (input, query) => {
    expect(parseAddress(input)).toEqual({ kind: 'search', query });
  });

  it.each([
    ['/Users/me/site/index.html', '/Users/me/site/index.html'],
    ['./index.html', './index.html'],
    ['../docs/a.html', '../docs/a.html'],
    ['~/site/index.html', '~/site/index.html'],
    ['C:\\site\\index.html', 'C:\\site\\index.html'],
    ['file:///Users/me/a%20b.html', '/Users/me/a b.html'],
    ['file:///C:/site/index.html', 'C:/site/index.html'],
  ])('%s is a file', (input, path) => {
    expect(parseAddress(input)).toEqual({ kind: 'file', path });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://user:pass@example.com', 'credentials'],
    ['https://user@example.com', 'credentials'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<b>x</b>', 'scheme'],
    ['chrome://settings', 'scheme'],
    ['devtools://devtools/bundled/inspector.html', 'scheme'],
    ['app://piarc/', 'scheme'],
    ['piarc://open?path=/x', 'scheme'],
    ['file://server/share/x.html', 'scheme'],
    ['x'.repeat(9000), 'tooLong'],
  ])('%s is refused (%s)', (input, reason) => {
    expect(parseAddress(input)).toEqual({ kind: 'refused', reason });
  });
});

describe('local', () => {
  it('knows this machine and private networks', () => {
    for (const host of ['localhost', 'LOCALHOST.', '127.8.0.1', '[::1]', 'a.localhost', 'x.test']) {
      expect(local(host), host).toBe(true);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'localhost.example.com']) {
      expect(local(host), host).toBe(false);
    }
  });
});

describe('searchUrl', () => {
  it('encodes the query', () => {
    expect(searchUrl('google', 'a b&c')).toBe('https://www.google.com/search?q=a%20b%26c');
    expect(searchUrl('baidu', '中文')).toBe('https://www.baidu.com/s?wd=%E4%B8%AD%E6%96%87');
  });
});
