// Checks for request params and results arriving over AHP (a system boundary): values are
// `unknown` until one of these functions has narrowed them.
import type {
  CoreWelcome,
  InputAttachment,
  InputMention,
  ModelPreferences,
  ModelRef,
  PolicyReviewParams,
} from '@piarc/protocol';

import { parsePreferences } from '../providers/preferences.js';
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

/** An optional non-empty string member. */
export function optionalString(method: string, params: Fields, name: string): string | undefined {
  const value = params[name];
  return value === undefined || value === null ? undefined : stringField(method, params, name);
}

/** The required `text` member: any string, empty included. */
export function textField(method: string, params: Fields): string {
  const value = params.text;
  if (typeof value !== 'string') {
    throw new AhpError('invalidParams', `${method}: text must be a string`, {
      details: { member: 'text' },
    });
  }
  return value;
}

/** A required array of non-empty strings. */
export function stringList(method: string, params: Fields, name: string): string[] {
  const value = params[name];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    throw new AhpError('invalidParams', `${method}: ${name} must be an array of strings`, {
      details: { member: name },
    });
  }
  return value;
}

/** An optional non-negative integer member, such as `lastSeq`. */
export function optionalCount(method: string, params: Fields, name: string): number | undefined {
  const value = params[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AhpError('invalidParams', `${method}: ${name} must be a non-negative integer`, {
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
    ...(typeof result.allowModelNetwork === 'boolean'
      ? { allowModelNetwork: result.allowModelNetwork }
      : {}),
    ...welcomePreferences(result.modelPreferences),
  };
}

/** The welcome's model preferences (T29); malformed ones are left out, not fatal. */
function welcomePreferences(value: unknown): { modelPreferences?: ModelPreferences } {
  if (value == null) return {};
  try {
    return { modelPreferences: parsePreferences(value) };
  } catch {
    return {};
  }
}

/** The `trust/get` result, or undefined when it is malformed. */
export function parseTrust(result: unknown): { trusted: boolean } | undefined {
  return isFields(result) && typeof result.trusted === 'boolean'
    ? { trusted: result.trusted }
    : undefined;
}

/** The user input of `session/prompt`, `session/steer` and `session/followUp`. */
export function inputFields(
  method: string,
  params: Fields,
): { text: string; mentions: InputMention[]; attachments: InputAttachment[] } {
  const text = textField(method, params);
  const mentions = listField(method, params, 'mentions', (value, index) => {
    if (
      isFields(value) &&
      typeof value.path === 'string' &&
      value.path.length > 0 &&
      isCount(value.start) &&
      isCount(value.end) &&
      value.start < value.end &&
      value.end <= text.length
    ) {
      return { path: value.path, start: value.start, end: value.end };
    }
    throw new AhpError(
      'invalidParams',
      `${method}: mentions[${String(index)}] is not a mention of the text`,
      {
        details: { member: 'mentions' },
      },
    );
  });
  const attachments = listField(method, params, 'attachments', (value, index) => {
    const blob = isFields(value) ? value.blob : undefined;
    const kind = isFields(value) ? attachmentKind(value.kind) : undefined;
    if (
      isFields(value) &&
      kind !== undefined &&
      typeof value.name === 'string' &&
      typeof value.mimeType === 'string' &&
      isFields(blob) &&
      typeof blob.path === 'string' &&
      typeof blob.sha256 === 'string' &&
      isCount(blob.size) &&
      (value.pageCount === undefined || isCount(value.pageCount))
    ) {
      return {
        kind,
        name: value.name,
        mimeType: value.mimeType,
        blob: { path: blob.path, sha256: blob.sha256, size: blob.size },
        ...(value.pageCount === undefined ? {} : { pageCount: value.pageCount }),
      };
    }
    throw new AhpError('invalidParams', `${method}: attachments[${String(index)}] is malformed`, {
      details: { member: 'attachments' },
    });
  });
  return { text, mentions, attachments };
}

function listField<T>(
  method: string,
  params: Fields,
  name: string,
  item: (value: unknown, index: number) => T,
): T[] {
  const value = params[name];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AhpError('invalidParams', `${method}: ${name} must be an array`, {
      details: { member: name },
    });
  }
  return value.map((entry: unknown, index) => item(entry, index));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function attachmentKind(value: unknown): 'image' | 'pdf' | undefined {
  return value === 'image' || value === 'pdf' ? value : undefined;
}

/** `policy/review`'s params (T46): Core's call, environment, policy and reviewer model. */
export function reviewParams(params: unknown): PolicyReviewParams {
  const method = 'policy/review';
  const fields = paramsObject(method, params);
  const object = (name: string): Fields => {
    const value = fields[name];
    if (!isFields(value)) {
      throw new AhpError('invalidParams', `${method}: ${name} must be an object`, {
        details: { member: name },
      });
    }
    return value;
  };
  const strings = (from: Fields, name: string): string[] => {
    const value = from[name];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new AhpError('invalidParams', `${method}: ${name} must be a list of strings`, {
        details: { member: name },
      });
    }
    return value;
  };
  const env = object('environment');
  const policy = object('policy');
  const model = object('model');
  const timeoutMs = fields.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AhpError('invalidParams', `${method}: timeoutMs must be a positive number`, {
      details: { member: 'timeoutMs' },
    });
  }
  const remotes = Array.isArray(env.remotes)
    ? env.remotes.flatMap((remote) =>
        isFields(remote) && typeof remote.name === 'string' && typeof remote.url === 'string'
          ? [{ name: remote.name, url: remote.url }]
          : [],
      )
    : [];
  const agentType = optionalString(method, env, 'agentType');
  return {
    sessionId: stringField(method, fields, 'sessionId'),
    toolCallId: stringField(method, fields, 'toolCallId'),
    tool: stringField(method, fields, 'tool'),
    input: object('input'),
    why: stringField(method, fields, 'why'),
    environment: {
      platform: stringField(method, env, 'platform'),
      workspace: stringField(method, env, 'workspace'),
      cwd: stringField(method, env, 'cwd'),
      remotes,
      sandboxed: env.sandboxed === true,
      ...(agentType === undefined ? {} : { agentType }),
    },
    policy: {
      environment: strings(policy, 'environment'),
      allow: strings(policy, 'allow'),
      softDeny: strings(policy, 'softDeny'),
      hardDeny: strings(policy, 'hardDeny'),
    },
    model: {
      provider: stringField(method, model, 'provider'),
      id: stringField(method, model, 'id'),
    },
    timeoutMs,
  };
}
