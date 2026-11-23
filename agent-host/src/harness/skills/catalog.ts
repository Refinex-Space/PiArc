// Core's answers about skills (T37, ADR-0054): `skills/list`, `skills/invoke`, `skills/match`,
// checked at the boundary before use. Only what the Agent Host relies on is checked strictly;
// the lists pass through to the client as Core sent them.
import type {
  CommandInfo,
  CurrentOutputStyle,
  OutputStyleInfo,
  ResourceIssue,
  SkillInfo,
  SkillsCatalog,
  SkillsInvokeResult,
  SkillsMatchResult,
} from '@piarc/protocol';

import { forkRun } from '../../runtime/input.js';
import { isObject } from '../../runtime/items.js';

const isString = (value: unknown): value is string => typeof value === 'string';
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
  value == null || check(value);

function isSkill(value: unknown): value is SkillInfo {
  return (
    isObject(value) &&
    isString(value.name) &&
    isString(value.description) &&
    isString(value.source) &&
    isString(value.path) &&
    isString(value.dir) &&
    typeof value.modelInvocable === 'boolean' &&
    typeof value.userInvocable === 'boolean' &&
    optional(value.visibility, isString) &&
    optional(value.arguments, isStrings) &&
    optional(value.allowedTools, isStrings) &&
    optional(value.paths, isStrings) &&
    optional(value.argumentHint, isString)
  );
}

function isCommand(value: unknown): value is CommandInfo {
  return (
    isObject(value) &&
    isString(value.name) &&
    isString(value.kind) &&
    isString(value.source) &&
    optional(value.description, isString) &&
    optional(value.argumentHint, isString) &&
    optional(value.aliases, isStrings)
  );
}

function isStyle(value: unknown): value is OutputStyleInfo {
  return (
    isObject(value) &&
    isString(value.name) &&
    isString(value.source) &&
    optional(value.instructions, isString)
  );
}

function isCurrent(value: unknown): value is CurrentOutputStyle {
  return isObject(value) && isString(value.name) && optional(value.missing, isString);
}

function isIssue(value: unknown): value is ResourceIssue {
  return isObject(value) && isString(value.path) && isString(value.message);
}

/** `skills/list`'s result, or undefined when it is not one. */
export function parseSkillsCatalog(value: unknown): SkillsCatalog | undefined {
  if (
    !isObject(value) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isSkill) ||
    !Array.isArray(value.commands) ||
    !value.commands.every(isCommand) ||
    !Array.isArray(value.outputStyles) ||
    !value.outputStyles.every(isStyle) ||
    !isCurrent(value.outputStyle) ||
    !(value.issues == null || (Array.isArray(value.issues) && value.issues.every(isIssue)))
  ) {
    return undefined;
  }
  return {
    skills: value.skills,
    commands: value.commands,
    outputStyles: value.outputStyles,
    outputStyle: value.outputStyle,
    ...(value.issues == null ? {} : { issues: value.issues }),
  };
}

/** `skills/invoke`'s result, or undefined when it is not one. */
export function parseInvokeResult(value: unknown): SkillsInvokeResult | undefined {
  const fork = isObject(value) ? forkRun(value.fork) : undefined;
  const allowed = value === null || !isObject(value) ? undefined : value.allowedTools;
  if (
    !isObject(value) ||
    !isString(value.name) ||
    !isString(value.content) ||
    !isString(value.dir) ||
    (value.fork != null && !fork) ||
    !(allowed == null || isStrings(allowed)) ||
    !(value.hooks == null || typeof value.hooks === 'boolean') ||
    !(value.warnings == null || Array.isArray(value.warnings))
  ) {
    return undefined;
  }
  return {
    name: value.name,
    content: value.content,
    dir: value.dir,
    ...(fork ? { fork } : {}),
    ...(isStrings(allowed) ? { allowedTools: allowed } : {}),
    ...(value.hooks == null ? {} : { hooks: value.hooks }),
    ...(Array.isArray(value.warnings)
      ? {
          warnings: value.warnings.filter(
            (w: unknown): w is NonNullable<SkillsInvokeResult['warnings']>[number] =>
              isObject(w) && isString(w.kind),
          ),
        }
      : {}),
  };
}

/** `skills/match`'s result, or undefined when it is not one. */
export function parseMatchResult(value: unknown): SkillsMatchResult | undefined {
  return isObject(value) && isStrings(value.matched) ? { matched: value.matched } : undefined;
}
