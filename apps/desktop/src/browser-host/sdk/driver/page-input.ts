// Ported from ego-browser package/ego-browser/src/driver/page-input.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: local typed services (upstream reuses the dropped v1 keyboard
// services); files are staged through services.stageUpload (the stageUpload binding) and only the
// staged copies reach DOM.setFileInputFiles; absolute paths are checked with string rules instead
// of node:path.

import type { CdpCall, CdpParams } from '../cdp-types.js';
import { resolveElementObjectId, type IframeSessions } from '../element-resolver.js';
import type { RefMap } from '../ref-map.js';
import { COMPOSED_TREE_HELPERS } from './action-target.js';

export interface PageInputServices {
  cdp: CdpCall;
  /**
   * PiArc: copies local files into the session's upload staging area (the
   * `stageUpload` binding, which applies Core's read policy) and answers the
   * staged copies in the same order. Only staged paths reach Chromium.
   */
  stageUpload(paths: readonly string[]): Promise<readonly string[]>;
}

const RESOLVE_FILE_INPUT_SOURCE = `function resolveFileInputForUpload() {
  ${COMPOSED_TREE_HELPERS}
  const isFileInput = (element) =>
    String(element?.tagName || "").toUpperCase() === "INPUT" &&
    String(element.type || "").toLowerCase() === "file";
  if (isFileInput(this)) return this;
  const isFileLabel = (element) =>
    String(element?.tagName || "").toUpperCase() === "LABEL" &&
    isFileInput(element.control);
  if (isFileLabel(this)) {
    return this.control;
  }
  const label = nearestComposedAncestor(this, isFileLabel);
  if (label) return label.control;
  const descendants = composedDescendantMatches(this, isFileInput, true);
  if (descendants.length === 1) return descendants[0];
  if (descendants.length > 1) {
    throw new TypeError(
      "page.setInputFiles selected a container with multiple file inputs",
    );
  }
  throw new TypeError(
    "page.setInputFiles requires a file input, its label, or a container with a file input",
  );
}`;

/** Set one or more local files on an input in one explicit Page session. */
export async function setInputFilesInPage(
  services: PageInputServices,
  sessionId: string,
  refMap: RefMap,
  selector: string,
  path: string | readonly string[],
  iframeSessions: IframeSessions = new Map<string, string>(),
): Promise<void> {
  const files = normalizeFilePaths(path, 'page.setInputFiles');
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true },
  );
  let inputObjectId: string | undefined;
  try {
    const input = await services.cdp(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: RESOLVE_FILE_INPUT_SOURCE,
        objectId: resolved.objectId,
        returnByValue: false,
        awaitPromise: false,
      },
      resolved.sessionId,
    );
    if (input.exceptionDetails) {
      throw new TypeError(
        firstText(input.exceptionDetails.exception?.description, input.exceptionDetails.text) ??
          'page.setInputFiles could not resolve a file input',
      );
    }
    inputObjectId = input.result?.objectId;
    if (!inputObjectId) {
      throw new TypeError('page.setInputFiles could not resolve a file input');
    }
    await setFilesOnBackendNode(services, resolved.sessionId, files, undefined, inputObjectId);
  } finally {
    if (inputObjectId && inputObjectId !== resolved.objectId) {
      await releaseObject(services, resolved.sessionId, inputObjectId);
    }
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}

/** Validate local file paths without touching the operating-system chooser. */
export function normalizeFilePaths(path: string | readonly string[], methodName: string): string[] {
  // Scripts pass anything; check the values rather than trust the type.
  const value: unknown = path;
  const files: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [value];
  if (
    !files.every(
      (file): file is string => typeof file === 'string' && file.length > 0 && isAbsolutePath(file),
    )
  ) {
    throw new TypeError(`${methodName} requires absolute file paths`);
  }
  return [...files];
}

/**
 * PiArc: node:path `isAbsolute` without Node. Accepts the absolute forms of
 * both platforms (POSIX `/...`, Windows `C:\...` or `C:/...`, UNC
 * `\\...`); Core resolves and checks the path again before staging the file.
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function firstText(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

/** Set files using the file input identity supplied by a chooser event. */
export async function setFilesOnBackendNode(
  services: PageInputServices,
  sessionId: string,
  files: readonly string[],
  backendNodeId?: number,
  objectId?: string,
): Promise<void> {
  // PiArc: Chromium only ever sees the staged copies of the files.
  const staged = await services.stageUpload(files);
  if (staged.length !== files.length) {
    throw new Error(
      `file staging answered ${String(staged.length)} paths for ${String(files.length)} files`,
    );
  }
  await services.cdp(
    'DOM.setFileInputFiles',
    {
      files: [...staged],
      ...(backendNodeId === undefined ? {} : { backendNodeId }),
      ...(objectId === undefined ? {} : { objectId }),
    },
    sessionId,
  );
}

function cdpAdapter(services: PageInputServices): {
  readonly sendRaw: CdpCall;
} {
  return {
    sendRaw: <M extends string>(method: M, params?: CdpParams<M>, sessionId?: string) =>
      services.cdp(method, params, sessionId),
  };
}

async function releaseObject(
  services: PageInputServices,
  sessionId: string,
  objectId: string,
): Promise<void> {
  await services.cdp('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined);
}
