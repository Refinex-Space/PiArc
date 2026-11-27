// The script host's `servers` and `startServer` bindings (ADR-0092): dispatched to the ports
// with the run's session, names checked like any untrusted input, results mapped for the SDK.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { fitImage, HostBindings, IMAGE_LIMITS, notePermission, noteRefused, permissionNote } =
  await import('./host-bindings.js');
const { serverInfo, serversResult } = await import('./start-page.js');

type Bindings = InstanceType<typeof HostBindings>;
type Ports = ConstructorParameters<typeof HostBindings>[1];
type Run = Parameters<Bindings['call']>[0];

const run = {
  runId: 'run-1',
  caller: { sessionId: 'main', touched: new Set<string>() },
  callSessionId: 'child',
  toolCallId: 'call-1',
} as unknown as Run;

function fixture() {
  const started: { sessionId: string; call: string; name: string }[] = [];
  const ports = {
    servers: (r: Run) =>
      Promise.resolve({
        trusted: true,
        servers: [],
        listening: [],
        problems: [r.caller.sessionId],
      }),
    startServer: (r: Run, name: string) => {
      started.push({ sessionId: r.caller.sessionId, call: r.toolCallId, name });
      return Promise.resolve(serverInfo(undefined, undefined, name));
    },
  } as unknown as Ports;
  const spaces = {} as unknown as ConstructorParameters<typeof HostBindings>[0];
  return { bindings: new HostBindings(spaces, ports), started };
}

describe('servers and startServer bindings', () => {
  it('answer for the run’s main session and call', async () => {
    const { bindings, started } = fixture();
    expect(await bindings.call(run, { op: 'servers' })).toMatchObject({ problems: ['main'] });
    expect(await bindings.call(run, { op: 'startServer', name: 'web' })).toMatchObject({
      name: 'web',
      status: 'idle',
    });
    expect(started).toEqual([{ sessionId: 'main', call: 'call-1', name: 'web' }]);
  });

  it('refuse a missing or overlong name', async () => {
    const { bindings, started } = fixture();
    for (const name of [undefined, 7, 'x'.repeat(201)]) {
      expect(await bindings.call(run, { op: 'startServer', name })).toMatchObject({
        error_code: 'EGO_INVALID_ARGUMENT',
      });
    }
    expect(started).toEqual([]);
  });
});

describe('serversResult', () => {
  it('lists every configuration with the session’s state and the listening ports', () => {
    const result = serversResult(
      {
        configs: [
          {
            name: 'web',
            source: 'piarc',
            command: 'npm run dev',
            cwd: '/w',
            port: 5173,
            url: 'http://localhost:5173/',
            fingerprint: 'f',
          },
          {
            name: 'api',
            source: 'claude',
            command: 'node api.js',
            cwd: '/w/api',
            port: 4000,
            url: 'http://localhost:4000/',
            fingerprint: 'g',
          },
        ],
        autoVerify: true,
        trusted: true,
        issues: [{ file: '.piarc/launch.json', line: 2, column: 4, message: 'unknown key' }],
      },
      {
        ports: [{ port: 5174, taskId: 'bg-000000000001', kind: 'devServer', title: 'web' }],
        declared: [5173, 4000],
        servers: [
          {
            name: 'web',
            status: 'ready',
            startedBy: 'agent',
            port: 5174,
            url: 'http://localhost:5174/',
            taskId: 'bg-000000000001',
          },
        ],
      },
    );
    expect(result.servers).toEqual([
      {
        name: 'web',
        status: 'ready',
        url: 'http://localhost:5174/',
        port: 5174,
        command: 'npm run dev',
        cwd: '/w',
        source: 'piarc',
        startedBy: 'agent',
      },
      {
        name: 'api',
        status: 'idle',
        url: 'http://localhost:4000/',
        port: 4000,
        command: 'node api.js',
        cwd: '/w/api',
        source: 'claude',
      },
    ]);
    expect(result.listening).toEqual([
      { port: 5174, url: 'http://localhost:5174/', title: 'web', kind: 'devServer' },
    ]);
    expect(result.problems).toEqual(['.piarc/launch.json:2:4 unknown key']);
  });
});

describe('noteRefused (B2.6.5)', () => {
  it('keeps each refused method once, bounded in count and length, for the audit row', () => {
    const refused = new Set<string>();
    noteRefused(refused, 'Network.getCookies');
    noteRefused(refused, 'Network.getCookies');
    noteRefused(refused, 'X.' + 'y'.repeat(500));
    for (let n = 0; n < 500; n += 1) noteRefused(refused, `Made.up${String(n)}`);
    expect(refused.size).toBe(100);
    expect([...refused][0]).toBe('Network.getCookies');
    expect([...refused].every((method) => method.length <= 128)).toBe(true);
  });
});

describe('refused permissions (B1.3.2)', () => {
  it('tells the model which permissions the agent’s pages were refused', () => {
    const refused = new Set<string>();
    expect(permissionNote(refused)).toBe('');
    notePermission(refused, 'media', 'https://meet.example.com');
    notePermission(refused, 'media', 'https://meet.example.com');
    notePermission(refused, 'geolocation', 'https://maps.example.com');
    for (let n = 0; n < 50; n += 1)
      notePermission(refused, 'notifications', `https://${String(n)}.example`);
    expect(refused.size).toBe(20);
    const note = permissionNote(refused);
    expect(note).toContain('media (https://meet.example.com)');
    expect(note).toContain('geolocation (https://maps.example.com)');
    expect(note).toMatch(/^\n\[PiArc\] /);
  });
});

/** A decoded image as nativeImage gives it, with encoders that only report sizes. */
function picture(width: number, height: number, bytesPerPixel = 1) {
  const encoded: string[] = [];
  const image = {
    getSize: () => ({ width, height }),
    resize: (size: { width?: number; height?: number }) =>
      picture(size.width ?? width, size.height ?? height, bytesPerPixel).image,
    toPNG: () => {
      encoded.push('png');
      return Buffer.alloc(width * height * bytesPerPixel);
    },
    toJPEG: (quality: number) => {
      encoded.push(`jpeg ${String(quality)}`);
      return Buffer.alloc(Math.ceil((width * height * bytesPerPixel * quality) / 400));
    },
  };
  return { image, encoded };
}

describe('fitImage (B2.6.7)', () => {
  it('keeps a small image at its real size, re-encoded as its own type', () => {
    const { image, encoded } = picture(800, 600);
    expect(fitImage(image, 'image/png')).toMatchObject({
      mediaType: 'image/png',
      width: 800,
      height: 600,
    });
    expect(encoded).toEqual(['png']);
  });

  it('scales the long edge down to 1568 px, keeping the aspect', () => {
    expect(fitImage(picture(3136, 1000).image, 'image/png')).toMatchObject({
      width: 1568,
      height: 500,
    });
    expect(fitImage(picture(900, 4704).image, 'image/jpeg')).toMatchObject({
      mediaType: 'image/jpeg',
      width: 300,
      height: 1568,
    });
  });

  it('lowers the quality of an image over 3.75 MiB, and refuses one that stays over', () => {
    const { image, encoded } = picture(1500, 1500, 3);
    const fitted = fitImage(image, 'image/png');
    expect(fitted?.mediaType).toBe('image/jpeg');
    expect(encoded[0]).toBe('png');
    expect(encoded.length).toBeGreaterThan(1);
    expect(Buffer.from(fitted?.data ?? '', 'base64').length).toBeLessThanOrEqual(
      IMAGE_LIMITS.bytes,
    );
    expect(fitImage(picture(1568, 1568, 40).image, 'image/png')).toBeUndefined();
    expect(fitImage(picture(0, 0).image, 'image/png')).toBeUndefined();
  });
});
