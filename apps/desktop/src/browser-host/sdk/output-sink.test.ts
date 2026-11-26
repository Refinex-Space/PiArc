// Ported from ego-browser package/ego-browser/src/output-sink.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest; the lifecycle fd test is dropped with installLifecycleFlush;
// observeOutput (PiArc) is tested.

import { afterEach, expect, test } from 'vitest';

import {
  bufferOutput,
  createRoundConsole,
  flushSink,
  markHardStop,
  observeOutput,
  resetSink,
} from './output-sink.js';
import { markPageObserved, recordUnhandledPage } from './page-discovery.js';

function fakeStream(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    text() {
      return chunks.join('');
    },
  };
}

afterEach(() => {
  observeOutput(null);
  resetSink();
});

test('flushSink writes buffered output verbatim on a clean run', () => {
  resetSink();
  bufferOutput('a\n');
  bufferOutput('b\n');
  const out = fakeStream();
  flushSink(out, false);
  expect(out.text()).toBe('a\nb\n');
});

test('a swallowed hard stop discards the buffer and prints the owned message once', () => {
  resetSink();
  bufferOutput('visiting\n');
  markHardStop('HARD STOP MESSAGE');
  markHardStop('a later re-report that must be ignored');
  const out = fakeStream();
  flushSink(out, false);
  expect(out.text()).toBe('HARD STOP MESSAGE\n');
});

test('a thrown hard stop stays silent so the propagating error is not echoed twice', () => {
  resetSink();
  bufferOutput('visiting\n');
  markHardStop('HARD STOP MESSAGE');
  const out = fakeStream();
  flushSink(out, true);
  expect(out.text()).toBe('');
});

test('an ordinary thrown error still flushes what was logged before it', () => {
  resetSink();
  bufferOutput('partial\n');
  const out = fakeStream();
  flushSink(out, true);
  expect(out.text()).toBe('partial\n');
});

test('flushSink runs at most once', () => {
  resetSink();
  bufferOutput('x\n');
  const out = fakeStream();
  flushSink(out, false);
  flushSink(out, false);
  expect(out.text()).toBe('x\n');
});

test('a message that already ends in a newline is not double-terminated', () => {
  resetSink();
  markHardStop('already terminated\n');
  const out = fakeStream();
  flushSink(out, false);
  expect(out.text()).toBe('already terminated\n');
});

test('flushSink appends unhandled pages after the script output', () => {
  resetSink();
  bufferOutput('saved rows\n');
  recordUnhandledPage({
    spaceId: 7,
    targetId: 'target-popup',
    label: 'p4',
    openerLabel: 'p1',
    url: 'https://example.test/popup',
  });
  const out = fakeStream();

  flushSink(out, false);

  expect(out.text()).toBe(
    'saved rows\n[ego-browser:pages]\nUnhandled page p4 from p1: https://example.test/popup\n',
  );
});

test('using a discovered Page suppresses its round-end notice', () => {
  resetSink();
  recordUnhandledPage({
    spaceId: 7,
    targetId: 'target-popup',
    label: 'p4',
    url: 'about:blank',
  });
  markPageObserved(7, 'target-popup');
  const out = fakeStream();

  flushSink(out, false);

  expect(out.text()).toBe('');
});

test('a hard stop discards unhandled-page notices with other output', () => {
  resetSink();
  recordUnhandledPage({
    spaceId: 7,
    targetId: 'target-popup',
    label: 'p4',
    url: 'about:blank',
  });
  markHardStop('STOP');
  const out = fakeStream();

  flushSink(out, false);

  expect(out.text()).toBe('STOP\n');
});

test('an unhandled page without a URL is reported as about:blank', () => {
  resetSink();
  recordUnhandledPage({ spaceId: 7, targetId: 'target-popup', label: 'p4', url: '' });
  const out = fakeStream();

  flushSink(out, false);

  expect(out.text()).toBe('[ego-browser:pages]\nUnhandled page p4: about:blank\n');
});

test('observeOutput sees every buffered chunk until it is cleared', () => {
  resetSink();
  const seen: string[] = [];
  observeOutput((chunk) => {
    seen.push(chunk);
  });
  const console = createRoundConsole();
  console.log('one', { value: 1 });
  console.warn('two');
  bufferOutput('three\n');
  observeOutput(null);
  bufferOutput('four\n');

  expect(seen).toEqual(['one { value: 1 }\n', '[warn] two\n', 'three\n']);
  const out = fakeStream();
  flushSink(out, false);
  expect(out.text()).toBe('one { value: 1 }\n[warn] two\nthree\nfour\n');
});

test('observed chunks do not change what a hard stop flushes', () => {
  resetSink();
  const seen: string[] = [];
  observeOutput((chunk) => {
    seen.push(chunk);
  });
  bufferOutput('business\n');
  markHardStop('STOP');
  const out = fakeStream();

  flushSink(out, false);

  expect(seen).toEqual(['business\n']);
  expect(out.text()).toBe('STOP\n');
});
