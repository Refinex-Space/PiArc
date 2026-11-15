// Public entry of @piarc/protocol: AHP types generated from the piarc-protocol crate, the
// protocol version, and the LF frame codec.
export type * from './generated/ahp.js';
export { PROTOCOL_VERSION } from './generated/version.js';
export {
  DEFAULT_MAX_FRAME_BYTES,
  FrameDecoder,
  MAX_NESTING,
  encodeFrame,
  type FrameError,
  type FrameResult,
} from './framing.js';
