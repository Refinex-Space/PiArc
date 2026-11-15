// What every PiArc tool definition shares: the profile's presentation on top of the parameter
// schema of the Pi tool it is built from ("tool parameters follow Pi's schema", T07).
import type { CoreIo } from './core-io.js';
import type { ToolPresentation } from './profile.js';

/** What a tool factory needs. */
export interface ToolSetup {
  /** Core I/O for the tool's session. */
  readonly io: CoreIo;
  /** Name, description and prompt lines from the session's Tool Profile. */
  readonly presentation: ToolPresentation;
}

/** The presentation members of a tool definition. */
export function presentationOf(presentation: ToolPresentation): {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
} {
  return {
    name: presentation.name,
    label: presentation.name,
    description: presentation.description,
    promptSnippet: presentation.snippet,
    promptGuidelines: [...presentation.guidelines],
  };
}
