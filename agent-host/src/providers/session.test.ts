import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { assert, describe, expect, it, vi } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { CoreIo, DEFAULT_PROFILE, ExecOutputRouter } from '../tools/index.js';
import { plainInput, type UserInput } from '../runtime/input.js';
import { SessionRegistry } from '../runtime/session-registry.js';
import { openWorkspace } from '../runtime/workspace.js';

describe('session model selection', () => {
  it('refuses image steers and busy model changes, then records the next model and effort across resume', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-selection-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    const first = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let settled = Promise.withResolvers<undefined>();
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    const faux = fauxProvider({
      provider: 'test-selection',
      models: [
        { id: 'text', reasoning: false, input: ['text'] },
        { id: 'reasoner', reasoning: true, input: ['text', 'image'] },
      ],
    });
    workspace.modelRuntime.registerNativeProvider(faux.provider);
    const ref = (id: string) => ({ provider: faux.provider.id, id });
    const registry = new SessionRegistry({
      workspace,
      tools: { kind: 'pi-native' },
      isTrusted: () => Promise.resolve(false),
      log: () => undefined,
      sinkFor: () => ({
        event: (method) => {
          if (method === 'turn/completed') settled.resolve(undefined);
        },
        delta: () => undefined,
        replaceable: () => undefined,
      }),
    });
    const id = 'switch-test';
    const seen: { id: string; effort?: string }[] = [];
    let requestsWithImages = 0;
    faux.setResponses([
      async () => {
        first.resolve(undefined);
        await release.promise;
        return fauxAssistantMessage('one');
      },
      (context, options, _state, model) => {
        requestsWithImages += context.messages.filter(
          (m) =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some((c) => c.type === 'image'),
        ).length;
        seen.push({ id: model.id, ...(options?.reasoning ? { effort: options.reasoning } : {}) });
        return fauxAssistantMessage('two');
      },
    ]);
    try {
      await registry.create(dir, ref('text'), id);
      await registry.prompt(id, 'first', plainInput('one').input);
      await first.promise;
      const image: UserInput = {
        text: 'image',
        mentions: [],
        attachments: [
          {
            kind: 'image',
            name: 'test.png',
            mimeType: 'image/png',
            blob: { path: 'test.png', size: 1, sha256: 'stub' },
          },
        ],
      };
      await expect(registry.input(id, 'image', image, 'steer')).rejects.toMatchObject({
        details: { reason: 'visionUnsupported' },
      });
      await expect(registry.input(id, 'follow', image, 'followUp')).rejects.toMatchObject({
        details: { reason: 'visionUnsupported' },
      });
      await expect(registry.setModel(id, ref('reasoner'), 'high')).rejects.toMatchObject({
        kind: 'sessionBusy',
      });
      release.resolve(undefined);
      await settled.promise;
      await expect(registry.setModel(id, ref('reasoner'), 'high')).resolves.toEqual({
        model: ref('reasoner'),
        effort: 'high',
      });
      settled = Promise.withResolvers<undefined>();
      await registry.prompt(id, 'second', plainInput('two').input);
      await settled.promise;
      expect(seen).toEqual([{ id: 'reasoner', effort: 'high' }]);
      expect(requestsWithImages).toBe(0);
      await registry.close(id);
      const file = SessionManager.findById(dir, id);
      assert.isDefined(file);
      const history = await readFile(file, 'utf8');
      expect(history).toContain('"modelId":"reasoner"');
      expect(history).toContain('"thinkingLevel":"high"');
      await registry.resume(id, dir);
      await expect(registry.models(id)).resolves.toMatchObject({
        model: ref('reasoner'),
        effort: 'high',
      });
    } finally {
      release.resolve(undefined);
      await registry.closeAll();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks a queued image again before delivery when a catalog reload removes vision', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-queued-image-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    const faux = fauxProvider({
      provider: 'queue-provider',
      models: [{ id: 'chat', input: ['text', 'image'] }],
    });
    workspace.modelRuntime.registerNativeProvider(faux.provider);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const rejected = Promise.withResolvers<string>();
    const bridge: CoreBridge = new CoreBridge((message) => {
      const request = message as { method: string; id: number };
      expect(request.method).toBe('exec/shells');
      bridge.handleResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: { bash: true, powershell: false },
      });
    });
    const registry = new SessionRegistry({
      workspace,
      tools: {
        kind: 'core',
        bridge,
        profile: DEFAULT_PROFILE,
        ioFor: (sessionId) =>
          new CoreIo({
            sessionId,
            bridge,
            execOutput: new ExecOutputRouter(),
            readBlob: () => Promise.resolve(Buffer.from('fixture')),
          }),
      },
      isTrusted: () => Promise.resolve(false),
      log: () => undefined,
      sinkFor: () => ({
        event: (method, payload) => {
          if (
            method === 'turn/completed' &&
            payload.status === 'failed' &&
            typeof payload.errorMessage === 'string'
          )
            rejected.resolve(payload.errorMessage);
        },
        delta: () => undefined,
        replaceable: () => undefined,
      }),
    });
    faux.setResponses([
      async () => {
        entered.resolve(undefined);
        await release.promise;
        return fauxAssistantMessage('done');
      },
    ]);
    try {
      const id = 'queue-test';
      await registry.create(dir, { provider: faux.provider.id, id: 'chat' }, id);
      await registry.prompt(id, 'first', plainInput('go').input);
      await entered.promise;
      const input: UserInput = {
        text: 'follow up',
        mentions: [],
        attachments: [
          {
            kind: 'image',
            name: 'pixel.png',
            mimeType: 'image/png',
            blob: { path: 'fixture', size: 7, sha256: 'test' },
          },
        ],
      };
      expect((await registry.input(id, 'next', input, 'followUp')).disposition).toBe('queued');
      // Equivalent to a refresh returning revised input capabilities, while Pi's open session
      // still holds the original model object with the image capability.
      workspace.modelRuntime.registerNativeProvider({
        ...faux.provider,
        getModels: () => faux.models.map((m) => ({ ...m, input: ['text'] })),
      });
      release.resolve(undefined);
      expect(await rejected.promise).toContain('not supported');
      expect(faux.state.callCount).toBe(1);
    } finally {
      release.resolve(undefined);
      await registry.closeAll();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies per-model settings: display name, default effort when selected, image input off (T29)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-model-settings-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    const faux = fauxProvider({
      provider: 'test-prefs',
      models: [
        { id: 'text', reasoning: false, input: ['text'] },
        { id: 'reasoner', reasoning: true, input: ['text', 'image'] },
      ],
    });
    workspace.modelRuntime.registerNativeProvider(faux.provider);
    const ref = (id: string) => ({ provider: faux.provider.id, id });
    const registry = new SessionRegistry({
      workspace,
      tools: { kind: 'pi-native' },
      isTrusted: () => Promise.resolve(false),
      log: () => undefined,
      sinkFor: () => ({
        event: () => undefined,
        delta: () => undefined,
        replaceable: () => undefined,
      }),
    });
    const id = 'prefs-test';
    try {
      await registry.setPreferences({
        models: {
          'test-prefs/reasoner': {
            displayName: 'Reasoner (work)',
            defaultEffort: 'low',
            vision: false,
          },
        },
      });
      await registry.create(dir, ref('text'), id);
      const listed = await registry.models(id);
      const reasoner = listed.models.find((m) => m.id === 'reasoner');
      expect(reasoner).toMatchObject({
        name: 'Reasoner (work)',
        vision: false,
        defaultEffort: 'low',
      });
      // Selected without an effort: the model's default effort applies.
      await expect(registry.setModel(id, ref('reasoner'))).resolves.toEqual({
        model: ref('reasoner'),
        effort: 'low',
      });
      // An explicit choice still wins.
      await expect(registry.setModel(id, ref('reasoner'), 'high')).resolves.toMatchObject({
        effort: 'high',
      });
      const image: UserInput = {
        text: 'image',
        mentions: [],
        attachments: [
          {
            kind: 'image',
            name: 'test.png',
            mimeType: 'image/png',
            blob: { path: 'test.png', size: 1, sha256: 'stub' },
          },
        ],
      };
      await expect(registry.prompt(id, 'image', image)).rejects.toMatchObject({
        details: { reason: 'visionUnsupported' },
      });
    } finally {
      await registry.closeAll();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
