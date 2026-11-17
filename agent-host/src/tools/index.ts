// PiArc's tool layer (architecture section 6.1): the canonical tools, built from Pi's tool
// code (or PiArc's own, keeping Pi's parameters) with every file and command operation
// delegated to Core (ADR-0004).
//
// | Canonical | Built from                      | Core methods                    |
// |-----------|---------------------------------|---------------------------------|
// | Read      | Pi read, on a stand-in path     | fs/stat, fs/read                |
// | Write     | Pi write, on a stand-in path    | fs/mkdir, fs/write              |
// | Edit      | Pi edit, on a stand-in path     | fs/stat, fs/read, fs/write      |
// | Bash      | PiArc's (Pi's parameters)       | exec/run, exec/kill, exec/output|
// | PowerShell| PiArc's, Windows only           | exec/run, exec/kill, exec/output|
// | Glob      | Pi find + FindOperations        | fs/stat, fs/glob                |
// | Grep      | PiArc's (Pi's schema and output)| fs/grep                         |
//
// Nothing below `src/tools/` imports `fs` or `child_process` (ESLint `no-restricted-imports`).
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { CoreIo, Shells } from './core-io.js';
import { createEditTool } from './edit.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import {
  CANONICAL_TOOLS,
  PI_BUILTIN_TOOL_NAMES,
  type CanonicalTool,
  type ToolProfile,
} from './profile.js';
import { createReadTool } from './read.js';
import type { ToolSetup } from './presentation.js';
import { createBashTool, createPowerShellTool } from './shell.js';
import { createWriteTool } from './write.js';

export {
  CoreIo,
  ExecOutputRouter,
  FileError,
  type CoreIoOptions,
  type Origin,
  type Shells,
} from './core-io.js';
export {
  CANONICAL_TOOLS,
  DEFAULT_PROFILE,
  PI_BUILTIN_TOOL_NAMES,
  profileWithOverrides,
  ToolNameMap,
  type CanonicalTool,
  type ToolPresentation,
  type ToolProfile,
} from './profile.js';
export { lsOperations } from './ls.js';

const FACTORIES: Record<CanonicalTool, (setup: ToolSetup) => ToolDefinition> = {
  Read: createReadTool,
  Write: createWriteTool,
  Edit: createEditTool,
  Bash: createBashTool,
  PowerShell: createPowerShellTool,
  Glob: createGlobTool,
  Grep: createGrepTool,
};

/** The session's tool definitions, presented as `profile` says: `Bash` only with bash,
 * `PowerShell` only with PowerShell (Windows). */
export function createToolSet(io: CoreIo, profile: ToolProfile, shells: Shells): ToolDefinition[] {
  return CANONICAL_TOOLS.filter(
    (tool) => (tool !== 'Bash' || shells.bash) && (tool !== 'PowerShell' || shells.powershell),
  ).map((tool) => FACTORIES[tool]({ io, presentation: profile[tool] }));
}

/**
 * Session options that give the model exactly the canonical tool set: the definitions as custom
 * tools, Pi's built-in tools excluded entirely (not merely inactive, so no extension can turn
 * them back on). MCP and extension tools are unaffected.
 */
export function toolOptions(
  io: CoreIo,
  profile: ToolProfile,
  shells: Shells,
): {
  customTools: ToolDefinition[];
  noTools: 'builtin';
  excludeTools: string[];
} {
  return {
    customTools: createToolSet(io, profile, shells),
    noTools: 'builtin',
    excludeTools: [...PI_BUILTIN_TOOL_NAMES],
  };
}
