// PiArc addition (not in upstream ego-browser): the CDP message types shared by the ported
// modules. Upstream reads every CDP reply and event as `any`; the port reads them through these
// types instead. Command and event payloads come from `devtools-protocol` (types only, BSD-3-Clause)
// wrapped in `Wire<T>`: every field may be missing, and the protocol's `any` (page-controlled
// values such as `RemoteObject.value`) becomes `unknown`, so code narrows before it trusts a value.
// The message envelope itself is validated where it enters (browser-runtime's message handler).

import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

/** A plain object from the wire or from a script. */
export type CdpObject = Record<string, unknown>;

/** Whether `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is CdpObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Data as it arrived over CDP: every field optional, `any` turned into `unknown`. */
export type Wire<T> =
  IsAny<T> extends true
    ? unknown
    : T extends readonly (infer E)[]
      ? Wire<E>[]
      : T extends object
        ? { [K in keyof T]?: Wire<T[K]> }
        : T;

export type CdpCommandMethod = keyof ProtocolMapping.Commands;
export type CdpEventMethod = keyof ProtocolMapping.Events;

type CommandParamsTuple<M extends CdpCommandMethod> = ProtocolMapping.Commands[M]['paramsType'];
type CommandReturn<M extends CdpCommandMethod> = ProtocolMapping.Commands[M]['returnType'];

/**
 * Parameters of a command: the protocol type for a known method literal, any object for a method
 * name only known at run time (the model's `page.cdp(method, params)`).
 */
export type CdpParams<M extends string> = M extends CdpCommandMethod
  ? CommandParamsTuple<M> extends []
    ? Record<string, never>
    : NonNullable<CommandParamsTuple<M>[0]>
  : CdpObject;

/** The `result` of a command as received. */
export type CdpResult<M extends string> = M extends CdpCommandMethod
  ? CommandReturn<M> extends object
    ? Wire<CommandReturn<M>>
    : CdpObject
  : CdpObject;

/** A command's full response message (browser-runtime's `browserCdp` answers this). */
export interface CdpResponse<M extends string> {
  readonly result?: CdpResult<M>;
  readonly sessionId?: string;
}

/**
 * Sends one command and answers its unwrapped `result` (the shape every driver's `services.cdp`
 * has upstream: `response.result || {}`).
 */
export type CdpCall = <M extends string>(
  method: M,
  params?: CdpParams<M>,
  sessionId?: string,
  timeoutMs?: number,
) => Promise<CdpResult<M>>;

/** One event message as received; narrow on `method` to read `params`. */
export type CdpEvent = {
  [M in CdpEventMethod]: {
    readonly method: M;
    readonly params?: ProtocolMapping.Events[M] extends [infer P] ? Wire<P> : CdpObject;
    readonly sessionId?: string;
  };
}[CdpEventMethod];

/** The params of one event type. */
export type CdpEventParams<M extends CdpEventMethod> = ProtocolMapping.Events[M] extends [infer P]
  ? Wire<P>
  : CdpObject;
