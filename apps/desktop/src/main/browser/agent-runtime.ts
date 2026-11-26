// Assembles the agent's side of the built-in browser (ADR-0089): the Spaces, the bindings and
// their ports, the script hosts and the bridge to Core. main.ts registers the host's IPC
// channel and the `core/browser` route with what this returns.

import type { WebContents } from 'electron';

import type { SnapshotOptions, SnapshotResult } from '../../shared/browser-host.js';
import { AgentBridge, type BridgeCore } from './agent-bridge.js';
import { AgentDownloads } from './agent-downloads.js';
import { AgentGate } from './agent-gate.js';
import { quarantine } from './quarantine.js';
import { StateReminders } from './state-reminders.js';
import { AgentSpaces, SpaceError } from './agent-spaces.js';
import { showCursor } from './cursor.js';
import { FrameTracker } from './frames.js';
import { HostBindings, type BindingPorts } from './host-bindings.js';
import { setUpHostSession } from './host-session.js';
import { ScriptHosts } from './script-host.js';
import type { BrowserService } from './service.js';
import { SnapshotError, takeSnapshot } from './snapshot.js';
import { parseLaunchView } from './dev-servers.js';
import { serverAnswer, serverInfo, serversResult, type StartPageCore } from './start-page.js';

export interface AgentRuntimeDeps {
  readonly service: BrowserService;
  readonly core: BridgeCore &
    Pick<StartPageCore, 'launchConfigs' | 'startDevServer'> & {
      browserSite(requestJson: string): Promise<string>;
      browserFiles(requestJson: string): Promise<string>;
      browserDownloadsDir(sessionId: string): string;
      browserState(requestJson: string): void;
    };
  /** The user's local development names (`*.test`, `*.local`). */
  localNames(): readonly string[];
  /** Whether `host` has sign-ins imported from Chrome in the session's workspace (B5.4). */
  importedHost(sessionId: string, host: string): Promise<boolean>;
  /** The built host page's folder and the page URL (the dev server's under forge start). */
  readonly hostFolder: string;
  readonly hostPage: string;
  readonly devOrigin: string | undefined;
  readonly preload: string;
  readonly devTools: boolean;
  readonly userAgent: string;
  /** The agent handed a Space to the user (B2.5.3). */
  handedOff(sessionId: string, space: string, reason: string): void;
  /** The user gave a Space the agent had handed over back: tell the agent (B2.5.3). */
  handedBack(sessionId: string): void;
}

/** Core's `browserFiles`: Core's message reaches the script as the binding's error. */
async function files(
  core: { browserFiles(requestJson: string): Promise<string> },
  request: Record<string, unknown>,
): Promise<{ staged: string[]; saved?: string }> {
  let answer: unknown;
  try {
    answer = JSON.parse(await core.browserFiles(JSON.stringify(request)));
  } catch (error) {
    throw new SpaceError(
      'PIARC_FILE_REFUSED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof answer !== 'object' || answer === null) {
    throw new SpaceError('PIARC_FILE_REFUSED', 'Core did not answer the file request');
  }
  const staged =
    'staged' in answer && Array.isArray(answer.staged)
      ? (answer.staged as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
  const saved = 'saved' in answer && typeof answer.saved === 'string' ? answer.saved : undefined;
  return { staged, ...(saved === undefined ? {} : { saved }) };
}

/** Runs a Core call for a binding; Core's message reaches the script under `code`. */
async function coreAnswer<T>(
  code: 'EGO_OPERATION_FAILED' | 'PIARC_SERVER_REFUSED',
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new SpaceError(code, error instanceof Error ? error.message : String(error));
  }
}

export interface AgentRuntime {
  readonly gate: AgentGate;
  readonly spaces: AgentSpaces;
  readonly hosts: ScriptHosts;
  readonly bridge: AgentBridge;
}

/** A snapshot of `contents`, with its out-of-process frames. */
async function snapshotOf(
  frames: FrameTracker,
  contents: WebContents,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  try {
    const attached = await frames.of(contents);
    return await takeSnapshot(
      (method, params, sessionId) => contents.debugger.sendCommand(method, params, sessionId),
      attached,
      options,
    );
  } catch (error) {
    if (error instanceof SnapshotError) throw new SpaceError(error.code, error.message);
    throw error;
  }
}

export function startAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const spaces = new AgentSpaces({
    model: (sessionId, workspace) => deps.service.agentModel(sessionId, workspace),
    handedOff: (sessionId, space, reason) => {
      deps.handedOff(sessionId, space, reason);
    },
  });
  const frames = new FrameTracker();
  // Filled below: the gate and the hosts need each other.
  const late: { hosts?: ScriptHosts } = {};
  const gate = new AgentGate({
    pageOf: (id) => deps.service.gatedPage(id),
    agentPagesOn: (host) => deps.service.agentPagesOn(host),
    runFor: (sessionId, space) => late.hosts?.runFor(sessionId, space),
    allowedPorts: (sessionId) =>
      new Set([
        ...deps.service.userPorts(sessionId),
        ...deps.service.devServers.allowedPorts(sessionId),
      ]),
    askCore: (json) => deps.core.browserSite(json),
    localNames: () => deps.localNames(),
    importedHost: (sessionId, host) => deps.importedHost(sessionId, host),
  });
  deps.service.setGate((details) =>
    gate.check({
      url: details.url,
      resourceType: details.resourceType,
      ...(details.webContentsId === undefined ? {} : { webContentsId: details.webContentsId }),
      referrer: details.referrer,
    }),
  );
  const ports: BindingPorts = {
    snapshot: (contents, options) => snapshotOf(frames, contents, options),
    stageUpload: async (run, paths) => {
      const answer = await files(deps.core, {
        op: 'stage',
        sessionId: run.callSessionId,
        toolCallId: run.toolCallId,
        paths,
      });
      for (const path of answer.staged) run.staged.add(path);
      return answer.staged;
    },
    saveFile: async (run, source, path) => {
      const download = run.downloads.get(source);
      if (download?.state !== 'completed') {
        throw new SpaceError(
          'PIARC_FILE_REFUSED',
          'Only a finished download of this call can be saved',
        );
      }
      const answer = await files(deps.core, {
        op: 'save',
        sessionId: run.callSessionId,
        toolCallId: run.toolCallId,
        source: download.file,
        path,
      });
      // Core copied the bytes; the copy is marked as from the internet like the user's.
      if (answer.saved !== undefined) await quarantine(answer.saved, download.item.getURL());
    },
    requestAccess: (run, hosts) => gate.requestAccess(run.caller.sessionId, run, hosts),
    servers: async (run) => {
      const sessionId = run.caller.sessionId;
      const launch = await coreAnswer('EGO_OPERATION_FAILED', async () =>
        parseLaunchView(JSON.parse(await deps.core.launchConfigs(sessionId))),
      );
      if (launch === undefined) {
        throw new SpaceError('EGO_OPERATION_FAILED', 'Core answered invalid launch configurations');
      }
      return serversResult(launch, deps.service.devServers.services(sessionId));
    },
    // The first start of a configuration's fingerprint in the session asks the user (a card
    // bound to this call); a refusal or an untrusted project fails the binding (ADR-0092).
    startServer: async (run, name) => {
      const state = await coreAnswer('PIARC_SERVER_REFUSED', async () =>
        serverAnswer(
          await deps.core.startDevServer(
            JSON.stringify({
              sessionId: run.caller.sessionId,
              name,
              agent: { sessionId: run.callSessionId, toolCallId: run.toolCallId },
              wait: true,
            }),
          ),
        ),
      );
      return serverInfo(undefined, state, name);
    },
    highlight: (contents, x, y, label) => {
      showCursor(contents, x, y, label);
    },
    browserVersion: {
      protocolVersion: '1.3',
      product: `Chrome/${process.versions.chrome}`,
      revision: '',
      userAgent: deps.userAgent,
      jsVersion: process.versions.v8,
    },
  };
  const hosts = new ScriptHosts({
    partitions: deps.service.partitions,
    bindings: new HostBindings(spaces, ports),
    spaces,
    pageUrl: deps.hostPage,
    preload: deps.preload,
    setUpSession: (session) => {
      setUpHostSession(session, deps.hostFolder, deps.devOrigin);
    },
    devTools: deps.devTools,
  });
  late.hosts = hosts;
  const downloads = new AgentDownloads({
    pageOf: (id) => deps.service.gatedPage(id),
    runFor: (sessionId, space) => hosts.runFor(sessionId, space),
    directory: (sessionId) => deps.core.browserDownloadsDir(sessionId),
    targetIdOf: (contents) => spaces.targetIdOf(contents),
  });
  deps.service.setAgentDownloads((contents, item) => downloads.take(contents, item));
  deps.service.setControl(async (sessionId, space, action) => {
    const run = hosts.runFor(sessionId, space);
    switch (action) {
      case 'stop':
        if (run !== undefined) hosts.stop(run);
        return;
      case 'takeOver':
        await spaces.userTakeOver(sessionId, space);
        return;
      case 'handBack':
        if (await spaces.userHandBack(sessionId, space)) deps.handedBack(sessionId);
        return;
    }
  });
  // B2.7.3: what the user changes between the agent's calls reaches its next request.
  const states = new StateReminders({
    summary: (sessionId) => deps.service.agentSummary(sessionId),
    running: (sessionId) => deps.service.agentRunning(sessionId),
    send: (sessionId, summary) => {
      deps.core.browserState(JSON.stringify({ sessionId, ...summary }));
    },
  });
  deps.service.setStateWatch((sessionId) => {
    states.changed(sessionId);
  });
  return {
    gate,
    spaces,
    hosts,
    bridge: new AgentBridge(deps.core, hosts, deps.service.devServers, (sessionId) => {
      states.runEnded(sessionId);
    }),
  };
}
