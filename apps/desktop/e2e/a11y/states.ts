// The accessibility state list (T43, architecture section 8.7): every page and component state
// axe checks, in the light and the dark theme (`t43-a11y.e2e.ts`). `states.test.ts` compares it
// with what the renderer registers: every settings page, rail and dock panel, dialog (each file
// that renders `<Dialog>`) and transcript row kind (`ROW_KINDS` of `transcript/row-label.ts`)
// needs an entry here, so a new page or row fails the check until it is listed and reached.
//
// Add a state: an entry here (`id` by its area; `source` for a dialog's file, `page` for a
// settings page, `panel` for a panel, `row` for a row kind) and a `checkState(page, id)` call in
// the journey of `t43-a11y.e2e.ts` that reaches it.

export type A11yArea = 'window' | 'settings' | 'row' | 'approval' | 'panel' | 'dialog' | 'state';

interface Base {
  readonly id: string;
  readonly area: A11yArea;
  /** What is on screen. */
  readonly note: string;
}

export type A11yState =
  | (Base & { readonly area: 'window' | 'approval' | 'state' })
  | (Base & { readonly area: 'settings'; readonly page: string })
  | (Base & { readonly area: 'panel'; readonly panel: string })
  | (Base & { readonly area: 'dialog'; readonly source: string })
  | (Base & { readonly area: 'row'; readonly row: string });

export const A11Y_STATES = [
  // Windows.
  { id: 'window:welcome', area: 'window', note: 'main window without a workspace' },
  { id: 'window:new-session', area: 'window', note: 'new session form of an open workspace' },
  { id: 'window:tool', area: 'window', note: 'a detached tool with return and pin controls' },
  { id: 'window:conversation', area: 'window', note: 'a session after a turn, sidebar and rail' },
  {
    id: 'window:message-search',
    area: 'window',
    note: 'indexed message results in the search dialog',
  },
  // Workbench settings: the native modal, its search popup and each registered page.
  {
    id: 'dialog:settings',
    area: 'dialog',
    source: 'settings/SettingsModal.tsx',
    note: 'modal settings in the originating workbench',
  },
  {
    id: 'state:settings-search',
    area: 'state',
    note: 'settings search results with a keyboard-selected option',
  },
  { id: 'settings:general', area: 'settings', page: 'general', note: 'General' },
  {
    id: 'settings:markdown',
    area: 'settings',
    page: 'markdown',
    note: 'Local Markdown image handling and reference paths',
  },
  { id: 'settings:appearance', area: 'settings', page: 'appearance', note: 'Appearance' },
  { id: 'settings:providers', area: 'settings', page: 'providers', note: 'Models and providers' },
  { id: 'settings:permissions', area: 'settings', page: 'permissions', note: 'Permissions' },
  { id: 'settings:sandbox', area: 'settings', page: 'sandbox', note: 'Sandbox' },
  { id: 'settings:proxy', area: 'settings', page: 'proxy', note: 'Proxy (detected system proxy)' },
  {
    id: 'settings:git',
    area: 'settings',
    page: 'git',
    note: 'Git (branches, push and pull, commits)',
  },
  {
    id: 'settings:browser',
    area: 'settings',
    page: 'browser',
    note: 'Browser: the agent, browsing data and Chrome sign-ins, pages (B5.5)',
  },
  { id: 'settings:agents', area: 'settings', page: 'agents', note: 'Subagents' },
  {
    id: 'settings:skills',
    area: 'settings',
    page: 'skills',
    note: 'Skills and plugins with an installed plugin (off)',
  },
  {
    id: 'settings:memory',
    area: 'settings',
    page: 'memory',
    note: 'Memory: the switches and the empty list of a workspace (T47)',
  },
  { id: 'settings:mcp', area: 'settings', page: 'mcp', note: 'MCP servers' },
  { id: 'settings:usage', area: 'settings', page: 'usage', note: 'Usage' },
  {
    id: 'settings:diagnostics',
    area: 'settings',
    page: 'diagnostics',
    note: 'Configuration diagnostics',
  },
  { id: 'settings:shortcuts', area: 'settings', page: 'shortcuts', note: 'Keyboard shortcuts' },
  // Transcript rows, one per row kind.
  { id: 'row:userMessage', area: 'row', row: 'userMessage', note: 'a sent message' },
  {
    id: 'row:optimistic',
    area: 'row',
    row: 'optimistic',
    note: 'a message Core did not take (not delivered, resend)',
  },
  { id: 'row:agentMessage', area: 'row', row: 'agentMessage', note: 'a reply with Markdown' },
  { id: 'row:reasoning', area: 'row', row: 'reasoning', note: 'a finished thinking block' },
  { id: 'row:group', area: 'row', row: 'group', note: 'a tool group (Read, Grep)' },
  { id: 'row:commandExecution', area: 'row', row: 'commandExecution', note: 'a Bash card' },
  {
    id: 'row:fileChange',
    area: 'row',
    row: 'fileChange',
    note: 'a file change card with its diff',
  },
  { id: 'row:error', area: 'row', row: 'error', note: 'an error card (authentication)' },
  {
    id: 'row:uncertain',
    area: 'row',
    row: 'uncertain',
    note: 'outcome unknown after the Agent Host died',
  },
  { id: 'row:working', area: 'row', row: 'working', note: 'the working row during a turn' },
  {
    id: 'row:permissionModeChanged',
    area: 'row',
    row: 'permissionModeChanged',
    note: 'a mode change record',
  },
  {
    id: 'row:contextCompaction',
    area: 'row',
    row: 'contextCompaction',
    note: 'a compaction note after /compact',
  },
  { id: 'row:reminder', area: 'row', row: 'reminder', note: 'a reminder in the detailed view' },
  { id: 'row:subagent', area: 'row', row: 'subagent', note: 'a subagent card' },
  { id: 'row:webSearch', area: 'row', row: 'webSearch', note: 'a web search with its sources' },
  { id: 'row:browser', area: 'row', row: 'browser', note: 'a Browser call with its screenshot' },
  { id: 'row:todo', area: 'row', row: 'todo', note: 'the task card (TodoWrite)' },
  { id: 'row:plan', area: 'row', row: 'plan', note: 'a submitted plan (ExitPlanMode)' },
  {
    id: 'row:question',
    area: 'row',
    row: 'question',
    note: 'an answered question (AskUserQuestion)',
  },
  { id: 'row:nextSteps', area: 'row', row: 'nextSteps', note: 'suggested next steps' },
  // Approval cards: the four kinds of section 8.2 and the plan card.
  { id: 'approval:command', area: 'approval', note: 'command card' },
  { id: 'approval:fileChange', area: 'approval', note: 'file change card with its diff' },
  { id: 'approval:permissionExpansion', area: 'approval', note: 'directory outside the workspace' },
  { id: 'approval:elicitation', area: 'approval', note: 'MCP server input request' },
  {
    id: 'dialog:elicitation',
    area: 'dialog',
    source: 'approvals/ElicitationCard.tsx',
    note: 'MCP elicitation form or URL',
  },
  { id: 'approval:question', area: 'approval', note: 'question form' },
  { id: 'approval:plan', area: 'approval', note: 'plan card' },
  // Session rail sections and independent tool tiles, one per registered panel.
  { id: 'panel:context', area: 'panel', panel: 'context', note: 'context card' },
  { id: 'panel:usage', area: 'panel', panel: 'usage', note: 'usage card' },
  { id: 'panel:tasks', area: 'panel', panel: 'tasks', note: 'task list card' },
  { id: 'panel:plan', area: 'panel', panel: 'plan', note: 'plan panel' },
  {
    id: 'panel:background-tasks-card',
    area: 'panel',
    panel: 'background-tasks-card',
    note: 'background tasks card',
  },
  {
    id: 'panel:background-tasks',
    area: 'panel',
    panel: 'background-tasks',
    note: 'background tasks panel with output',
  },
  { id: 'panel:changes-card', area: 'panel', panel: 'changes-card', note: 'changes card' },
  {
    id: 'panel:changes',
    area: 'panel',
    panel: 'changes',
    note: 'Changes panel with a comment being written and saved ones',
  },
  { id: 'panel:terminal', area: 'panel', panel: 'terminal', note: 'terminal panel' },
  {
    id: 'state:git-changes',
    area: 'state',
    note: 'Git tool in a repository: all changes against the base branch, files and commits',
  },
  {
    id: 'state:git-commit',
    area: 'state',
    note: 'Git tool: the Commit view with a staged file and the message box',
  },
  { id: 'state:git-branches', area: 'state', note: 'Git tool: the branch popup' },
  {
    id: 'state:browser-start',
    area: 'state',
    note: 'preview: the start page with a launch configuration and the focused address bar',
  },
  {
    id: 'state:browser-server-failed',
    area: 'state',
    note: 'preview: a development server that failed, with its last log lines and actions',
  },
  {
    id: 'state:browser-console',
    area: 'state',
    note: 'preview: the console drawer with a message, a warning and an uncaught error',
  },
  {
    id: 'state:git-log',
    area: 'state',
    note: 'Git tool: the Log view with the commit graph and the details of a commit',
  },
  { id: 'state:git-stashes', area: 'state', note: 'Git tool: a stash and its details' },
  {
    id: 'state:git-merge-view',
    area: 'state',
    note: 'Git tool: the three-way merge view of a conflicted file',
  },
  {
    id: 'state:git-pull-request',
    area: 'state',
    note: "Git tool: the Commit view with the branch's pull request on GitHub (fake gh)",
  },
  {
    id: 'state:git-review-inline',
    area: 'state',
    note: 'Git tool: review findings under their lines in the diff',
  },
  {
    id: 'state:git-review-list',
    area: 'state',
    note: 'Git tool: review findings as a list grouped by file',
  },
  { id: 'panel:side-chat', area: 'panel', panel: 'side-chat', note: 'side conversation' },
  {
    id: 'state:md-read',
    area: 'state',
    note: 'Markdown reading with local images, math and footnotes',
  },
  {
    id: 'state:md-outline',
    area: 'state',
    note: 'hoverable heading rail and keyboard-operable document outline',
  },
  {
    id: 'state:md-code-language',
    area: 'state',
    note: 'searchable code card footer with language suggestions',
  },
  { id: 'state:md-live', area: 'state', note: 'live Markdown editor and its formatting controls' },
  { id: 'state:md-split', area: 'state', note: 'Markdown source alongside its rendered draft' },
  {
    id: 'dialog:md-image',
    area: 'dialog',
    source: 'files/markdown/MediaViewer.tsx',
    note: 'pan, zoom and rotate local Markdown images and rendered Mermaid diagrams',
  },
  { id: 'panel:files', area: 'panel', panel: 'files', note: 'workspace files tile' },
  { id: 'state:files-source', area: 'state', note: 'file tabs, source lines and the file tree' },
  {
    id: 'state:md-selection',
    area: 'state',
    note: 'formatting toolbar anchored to a real text selection',
  },
  {
    id: 'state:md-body-menu',
    area: 'state',
    note: 'contextual Markdown editing and clipboard actions',
  },
  {
    id: 'state:md-table-controls',
    area: 'state',
    note: 'row and column actions on an editable document table',
  },
  {
    id: 'state:md-slash',
    area: 'state',
    note: 'grouped document commands and the diagram submenu',
  },
  { id: 'state:files-editor', area: 'state', note: 'editable project file' },
  {
    id: 'dialog:files-discard',
    area: 'dialog',
    source: 'files/FilesPanel.tsx',
    note: 'dirty file close confirmation',
  },

  { id: 'panel:preview', area: 'panel', panel: 'preview', note: 'session preview tile' },
  {
    id: 'state:browser-picks',
    area: 'state',
    note: 'preview: picker on, tray with a picked element card (B3.1)',
  },
  {
    id: 'state:browser-annotate',
    area: 'state',
    note: 'preview: frozen page with the annotation tools and a numbered marker (B3.3)',
  },
  {
    id: 'dialog:browser-annotate-discard',
    area: 'dialog',
    source: 'browser/AnnotateCanvas.tsx',
    note: 'leaving an annotation that is not in the conversation',
  },
  // Dialogs, one or more per file that renders `<Dialog>`.
  {
    id: 'dialog:workspace-search',
    area: 'dialog',
    source: 'shell/WorkspaceSearch.tsx',
    note: 'search projects and sessions',
  },
  { id: 'dialog:trust', area: 'dialog', source: 'shell/TrustDialog.tsx', note: 'trust a folder' },
  {
    id: 'dialog:command-palette',
    area: 'dialog',
    source: 'shell/CommandPalette.tsx',
    note: 'Mod+K',
  },
  { id: 'dialog:shortcuts', area: 'dialog', source: 'shell/ShortcutsDialog.tsx', note: 'Mod+/' },
  {
    id: 'dialog:output-style',
    area: 'dialog',
    source: 'shell/OutputStyleDialog.tsx',
    note: '/output-style',
  },
  {
    id: 'dialog:model-switch',
    area: 'dialog',
    source: 'shell/ModelMenus.tsx',
    note: 'the cost of switching models',
  },
  {
    id: 'dialog:rewind',
    area: 'dialog',
    source: 'changes/RewindDialog.tsx',
    note: 'rewind to a message',
  },
  {
    id: 'dialog:add-service',
    area: 'dialog',
    source: 'settings/ServiceChooser.tsx',
    note: 'add a model service',
  },
  {
    id: 'dialog:chrome-import',
    area: 'dialog',
    source: 'settings/ChromeImportDialog.tsx',
    note: 'import sign-ins from Chrome (no Chrome in the test home)',
  },
  {
    id: 'dialog:sign-in',
    area: 'dialog',
    source: 'settings/SignInSection.tsx',
    note: 'sign in with a code',
  },
  {
    id: 'dialog:git-prompt',
    area: 'dialog',
    source: 'changes/git/GitPrompts.tsx',
    note: 'Git: a new branch name',
  },
  {
    id: 'dialog:git-history',
    area: 'dialog',
    source: 'changes/git/HistoryPrompts.tsx',
    note: 'Git: reset the branch to a commit',
  },
  {
    id: 'dialog:git-conflicts',
    area: 'dialog',
    source: 'changes/git/conflicts.tsx',
    note: 'Git: the conflicted files',
  },
  {
    id: 'dialog:git-merge-unresolved',
    area: 'dialog',
    source: 'changes/git/MergeView.tsx',
    note: 'Git: apply a merge result with conflicts left',
  },
  {
    id: 'dialog:git-rebase',
    area: 'dialog',
    source: 'changes/git/RebaseDialog.tsx',
    note: 'Git: an interactive rebase',
  },
  {
    id: 'dialog:git-pull-request',
    area: 'dialog',
    source: 'changes/git/PullRequest.tsx',
    note: 'Git: create a pull request',
  },
  {
    id: 'dialog:terminal-text',
    area: 'dialog',
    source: 'terminal/TerminalPanel.tsx',
    note: 'the screen as text',
  },
  // Empty and error states.
  {
    id: 'state:changes-empty',
    area: 'state',
    note: 'Changes panel of a session that changed nothing',
  },
  {
    id: 'state:conversation-loading',
    area: 'state',
    note: 'a session whose history is still being read: the placeholder',
  },
  {
    id: 'state:conversation-failed',
    area: 'state',
    note: 'a session whose history could not be read: the error with Retry',
  },
] as const satisfies readonly A11yState[];

export type A11yStateId = (typeof A11Y_STATES)[number]['id'];
