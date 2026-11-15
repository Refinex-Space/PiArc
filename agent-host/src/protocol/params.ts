// Checks for request params and results arriving over AHP (a system boundary): values are
// `unknown` until one of these functions has narrowed them.
import type { CoreWelcome, ModelRef } from '@piarc/protocol';

import { AhpError } from './errors.js';

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The params object of a request. */
export function paramsObject(method: string, params: unknown): Fields {
  if (!isFields(params)) {
    throw new AhpError('invalidParams', `${method}: params must be an object`);
  }
  return params;
}

/** A required string member. */
export function stringField(method: string, params: Fields, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AhpError('invalidParams', `${method}: ${name} must be a non-empty string`, {
      details: { member: name },
    });
  }
  return value;
}

/** The optional `model` member of `session/create`. */
export function modelField(method: string, params: Fields): ModelRef | undefined {
  const value = params.model;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isFields(value) || typeof value.provider !== 'string' || typeof value.id !== 'string') {
    throw new AhpError('invalidParams', `${method}: model must be { provider, id }`, {
      details: { member: 'model' },
    });
  }
  return { provider: value.provider, id: value.id };
}

/** The `core/welcome` result of `host/hello`, or undefined when it is malformed. */
export function parseWelcome(result: unknown): CoreWelcome | undefined {
  if (
    !isFields(result) ||
    typeof result.protocol !== 'string' ||
    !Array.isArray(result.enabled) ||
    !result.enabled.every((name) => typeof name === 'string') ||
    typeof result.workspace !== 'string' ||
    typeof result.connectionEpoch !== 'number'
  ) {
    return undefined;
  }
  return {
    protocol: result.protocol,
    enabled: result.enabled.filter((name): name is string => typeof name === 'string'),
    workspace: result.workspace,
    connectionEpoch: result.connectionEpoch,
  };
}

/** The `trust/get` result, or undefined when it is malformed. */
export function parseTrust(result: unknown): { trusted: boolean } | undefined {
  return isFields(result) && typeof result.trusted === 'boolean'
    ? { trusted: result.trusted }
    : undefined;
}
