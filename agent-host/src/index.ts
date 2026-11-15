// Public entry of the Agent Host workspace, for tests and tooling; the process entry point
// is main.ts.
export { EXIT, HOST_CAPABILITIES, runHost, type HostOptions, type RunningHost } from './host.js';
export { AhpError } from './protocol/errors.js';
export { OutboundQueue, type FrameSink, type OutboundStats } from './protocol/outbound.js';
export { CoreBridge, DEFAULT_BRIDGE_TIMEOUT_MS } from './runtime/core-bridge.js';
export { Projector, type ProjectionSink } from './runtime/projector.js';
