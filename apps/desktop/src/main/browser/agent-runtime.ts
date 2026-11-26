// Assembles the agent's side of the built-in browser (ADR-0089): the Spaces, the bindings and
// their ports, the script hosts and the bridge to Core. main.ts registers the host's IPC
// channel and the `core/browser` route with what this returns.

import type { WebContents } from 'electron';

import type { SnapshotOptions, SnapshotResult } from '../../shared/browser-host.js';
import { AgentBridge, type BridgeCore } from './agent-bridge.js';
import { AgentGate } from './agent-gate.js';
import { AgentSpaces, SpaceError } from './agent-spaces.js';
import { showCursor } from './cursor.js';
import { FrameTracker } from './frames.js';
import { HostBindings, type BindingPorts } from './host-bindings.js';
import { setUpHostSession } from './host-session.js';
import { ScriptHosts } from './script-host.js';
import type { BrowserService } from './service.js';
import { SnapshotError, takeSnapshot } from './snapshot.js';

export interface AgentRuntimeDeps {
  readonly service: BrowserService;
  readonly core: BridgeCore & { browserSite(requestJson: string): Promise<string> };
  /** The user's local development names (`*.test`, `*.local`). */
  localNames(): readonly string[];
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
    userPorts: (sessionId) => deps.service.userPorts(sessionId),
    askCore: (json) => deps.core.browserSite(json),
    localNames: () => deps.localNames(),
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
    stageUpload: () =>
      Promise.reject(
        new SpaceError(
          'PIARC_FILE_REFUSED',
          'Uploading files from the agent is not available in this build',
        ),
      ),
    saveFile: () =>
      Promise.reject(
        new SpaceError(
          'PIARC_FILE_REFUSED',
          'Saving downloads from the agent is not available in this build',
        ),
      ),
    requestAccess: (run, hosts) => gate.requestAccess(run.caller.sessionId, run, hosts),
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
  return { gate, spaces, hosts, bridge: new AgentBridge(deps.core, hosts) };
}
