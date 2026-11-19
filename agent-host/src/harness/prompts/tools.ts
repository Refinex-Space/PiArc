// The default Tool Profile's contributions to the prompt. An overridden presentation can
// supply its own snippet and guidelines for the same canonical operation.
import type { CanonicalTool, ToolPresentation } from '../../tools/profile.js';

export const TOOL_GUIDANCE = {
  Read: {
    snippet: 'Read: show a text file, image, PDF or notebook',
    guidelines: [
      'Inspect the relevant range before editing. Numbered prefixes identify the lines and are separate from the file text.',
    ],
  },
  Write: {
    snippet: 'Write: create a file or replace all of its text',
    guidelines: [
      'Supply the entire intended document. An existing file requires a current read before replacement.',
    ],
  },
  Edit: {
    snippet: 'Edit: replace exact passages of an existing file',
    guidelines: [
      'Choose an anchor that identifies the intended passage uniquely. Keep separate replacements disjoint.',
    ],
  },
  Bash: {
    snippet: 'Bash: run a shell command',
    guidelines: [
      'Check the working directory before running a command that changes files. Inspect the saved output when a preview is incomplete.',
    ],
  },
  PowerShell: {
    snippet: 'PowerShell: run a PowerShell command',
    guidelines: [
      'Supply paths for the current invocation. A directory change within the command ends with that invocation.',
    ],
  },
  Glob: {
    snippet: 'Glob: find files by name or path pattern',
    guidelines: [
      'Choose a starting directory and a pattern specific enough to keep the returned paths manageable.',
    ],
  },
  Grep: {
    snippet: 'Grep: search file contents with a regular expression',
    guidelines: [
      'Set literal mode when punctuation should match itself. Use surrounding lines to interpret a match.',
    ],
  },
  EnterPlanMode: {
    snippet: 'EnterPlanMode: switch to read-only planning before a larger change',
    guidelines: [
      'Plan first when a change is broad or its approach is unclear; small, clear edits need no plan.',
    ],
  },
  ExitPlanMode: {
    snippet: 'ExitPlanMode: submit the finished plan for approval',
    guidelines: [
      'Submit once exploration is done, with enough detail that the steps can be followed as written.',
    ],
  },
  TodoWrite: {
    snippet: 'TodoWrite: record and update the task list of multi-step work',
    guidelines: ['Update the list as each task starts and finishes, not in one batch at the end.'],
  },
  AskUserQuestion: {
    snippet: 'AskUserQuestion: ask the user structured questions',
    guidelines: [
      'Ask only what the other tools cannot establish, and list the recommended option first.',
    ],
  },
  SuggestNextSteps: {
    snippet: 'SuggestNextSteps: offer follow-ups at the end of a turn',
    guidelines: ['Offer next steps only when there are clear and useful follow-ups.'],
  },
} satisfies Record<CanonicalTool, Pick<ToolPresentation, 'snippet' | 'guidelines'>>;
