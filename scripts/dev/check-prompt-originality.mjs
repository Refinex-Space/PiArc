// Compare the shipped English prompt with the local clean-room corpus. The reference is
// data only: none of its code is loaded, and no reference text or matching words are logged.
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

import { capture, repoRoot } from '../lib/repo.mjs';

const width = 10;

/** Render all tool guidance, including tools available on just one platform, the tool
 * descriptions and the reminder texts, from source. */
function render() {
  const bundled = buildSync({
    stdin: {
      contents: `
        import { assembleSystem } from './agent-host/src/harness/prompts/system.ts';
        import * as notice from './agent-host/src/harness/prompts/notices.ts';
        import { SUMMARY_SYSTEM, summaryPrompt, fileLists } from './agent-host/src/harness/prompts/compaction.ts';
        import { CANONICAL_TOOLS, DEFAULT_PROFILE, conservativeProfile } from './agent-host/src/tools/profile.ts';
        import * as web from './agent-host/src/harness/prompts/web-fetch.ts';
        import * as sub from './agent-host/src/harness/prompts/subagents.ts';
        import * as tasks from './agent-host/src/harness/prompts/tasks.ts';
        import * as mcp from './agent-host/src/harness/prompts/mcp.ts';
        import * as skills from './agent-host/src/harness/prompts/skills.ts';
        import * as styles from './agent-host/src/harness/prompts/output-styles.ts';
        import * as search from './agent-host/src/harness/prompts/web-search.ts';
        import { HOOK_JUDGE_SYSTEM } from './agent-host/src/harness/prompts/hook-judge.ts';
        import * as review from './agent-host/src/harness/prompts/auto-review.ts';
        import * as memory from './agent-host/src/harness/prompts/auto-memory.ts';
        import * as commit from './agent-host/src/harness/prompts/commit-message.ts';
        import * as assist from './agent-host/src/harness/prompts/git-assist.ts';
        import * as browserNotices from './agent-host/src/harness/prompts/browser-notices.ts';
        const system = assembleSystem(CANONICAL_TOOLS, DEFAULT_PROFILE, [],
          {cwd: '', platform: '', date: '', gitStatus: ''}).text;
        const conservative = conservativeProfile(DEFAULT_PROFILE);
        const descriptions = CANONICAL_TOOLS.flatMap((tool) =>
          // T29: the conservative profile's own descriptions too.
          [...new Set([DEFAULT_PROFILE[tool].description, conservative[tool].description])]);
        const todo = [{ content: '', status: 'pending' }];
        const notices = [notice.PLAN_ON,
          ...['default', 'acceptEdits', 'bypassPermissions', 'auto'].map(notice.planOff),
          notice.staleListNotice(todo, 0),
          // T27: reminders, what a compaction gives back, the summary request.
          notice.hookContextNotice('Stop', ''), notice.hookContextNotice('SessionStart', ''),
          notice.fileChangedNotice('', 'modified'), notice.fileChangedNotice('', 'deleted'),
          notice.backgroundTaskNotice('', ''), notice.RESTORE_INTRO,
          notice.restoredPlan('', 'default'), notice.restoredTodos(todo),
          notice.restoredSkill('', ''), notice.restoredFile('', ''), notice.omittedFiles(['']),
          notice.cutNote(0), SUMMARY_SYSTEM,
          summaryPrompt({ transcript: '', turnStart: '', previousSummary: '', focus: '',
            hookInstructions: '' }), fileLists([''], ['']),
          // T29: the task list nudge of the conservative profile and WebFetch's extraction.
          notice.startListNotice(0), web.EXTRACT_SYSTEM, web.extractionPrompt('', '', '', true),
          web.crossHostRedirect('', '', 301),
          // T31: the built-in subagent types, the Agent tool's type list and the run notices.
          ...[sub.GENERAL_PURPOSE, sub.EXPLORE, sub.PLAN].flatMap((t) => [t.description, t.identity]),
          sub.withTypes('', [{ name: '', description: '' }]),
          sub.backgroundStarted('', ''), sub.backgroundFinished('', '', '', '', ''),
          sub.partialReport(0, ''), sub.EMPTY_REPORT, sub.toolNotAvailable(''),
          // T35: the note after the report of a subagent whose worktree kept its changes.
          sub.worktreeKept('', ''),
          // T32: KillShell's and Monitor's results.
          tasks.taskStopped('', '', '', ''), tasks.taskAlreadyEnded('', 'completed', ''),
          tasks.taskUnknown(''), tasks.monitorStarted('', '', 300000, 3600000),
          // T36: ToolSearch, the system prompt's MCP section and the change reminders.
          mcp.TOOL_SEARCH_DESCRIPTION,
          mcp.mcpSection([{ name: '', deferred: true }, { name: '', instructions: ' ', deferred: false }]) ?? '',
          ...[true, false].map((deferred) =>
            mcp.changeReminder({ name: '', added: [''], removed: [''], deferred, instructions: '' })),
          // T37: the skills index, its change reminders, Skill's results, the output styles.
          skills.SKILLS_INDEX_INTRO, skills.skillsChanged([''], ['']), skills.skillAlreadyLoaded(''),
          skills.skillLoaded('', '', '', ['']), skills.SKILL_UNTRUSTED_NOTE,
          skills.skillAllowedNote(['']),
          ...Object.entries(styles.BUILT_IN_STYLES).map(([name, text]) => styles.styleSection(name, text)),
          styles.styleChanged('', ' '), styles.styleChanged('', undefined),
          // T38: WebSearch's native request and results, the prompt hooks' judgement, the
          // hook notices of SubagentStop and PostToolBatch.
          search.NATIVE_SEARCH_SYSTEM, search.nativeSearchPrompt(''),
          search.searchResultText('', '', [{ title: '', url: '', snippet: ' ' }], ' '),
          search.searchResultText('', '', []), search.NO_SEARCH_BACKEND, search.nativeSearchFailed(''),
          HOOK_JUDGE_SYSTEM, notice.hookContextNotice('SubagentStop', ''),
          notice.hookStoppedRun('PostToolBatch', ''),
          // T46: Auto mode's review prompt, its answer tool and the tool's parameters.
          review.AUTO_REVIEW_SYSTEM, review.REVIEW_TOOL_DESCRIPTION,
          ...Object.values(review.REVIEW_TOOL_PARAMETERS.properties).map((p) => p.description),
          // T47: the lines around the auto memory index, the managed instructions and a note
          // restored after a compaction (the tool's description and guidance come with the
          // profile and the system prompt above).
          memory.MEMORY_PREAMBLE, memory.managedSource(''), memory.restoredMemory(''),
          // ADR-0086, ADR-0087: the Git tool's commit message, PR description and review requests.
          commit.COMMIT_MESSAGE_SYSTEM, ...Object.values(commit.LANGUAGE_REQUIREMENT), commit.AMEND_NOTE,
          assist.PR_DESCRIPTION_SYSTEM, assist.REVIEW_SYSTEM, ...Object.values(assist.ASSIST_LANGUAGE),
          // ADR-0092: the reminder after the agent changed a running dev server's front end.
          browserNotices.browserVerifyNotice(' ' + String.fromCharCode(10) + ' ')];
        process.stdout.write([system, ...descriptions, ...notices].join(String.fromCharCode(10)));`,
      resolveDir: repoRoot,
    },
    platform: 'node',
    bundle: true,
    write: false,
  });
  const source = bundled.outputFiles[0];
  if (!source) throw new Error('Could not build the PiArc prompt');
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: source.contents,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Could not render the PiArc prompt');
  return [result.stdout, ...sourceTexts()].join('\n');
}

/** Model-visible literals that no render above reaches (R3): every `description` of a tool
 * parameter schema in the Harness Kit (its subdirectories too, T31) and the tool layer, and the
 * sentences of at least five words that session memory, the reminder channel, interruption, the
 * result budget, the subagent runs (T31), Bash's background results and Core's background task
 * notices (T32), the terminal texts Core writes (T33: the screen file's header, the
 * command-finished and sharing notices) and the MCP pool's results and errors (T36) write. */
function sourceTexts() {
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const texts = [];
  for (const dir of [
    'agent-host/src/harness',
    'agent-host/src/harness/subagents',
    'agent-host/src/tools',
  ]) {
    for (const name of readdirSync(path.join(repoRoot, dir))) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(path.join(repoRoot, dir, name), 'utf8');
      const at = new RegExp(literal.source, 'y');
      for (const m of source.matchAll(/description:\s*/g)) {
        at.lastIndex = m.index + m[0].length;
        const found = at.exec(source);
        if (found) texts.push(found[1] ?? found[2] ?? found[3] ?? '');
      }
    }
  }
  for (const file of [
    'agent-host/src/harness/session-memory.ts',
    'agent-host/src/harness/reminders.ts',
    'agent-host/src/harness/interruption.ts',
    'agent-host/src/harness/tool-results.ts',
    'agent-host/src/runtime/subagents.ts',
    'agent-host/src/runtime/subagent-session.ts',
    // T32: Bash's background results, and the notices Core writes (completion, Monitor lines).
    'agent-host/src/tools/shell.ts',
    'crates/piarc-core/src/tasks/feed.rs',
    // T33: the terminal task's screen-file header and its notices.
    'crates/piarc-core/src/terminal/bound.rs',
    // T36: what the MCP pool and extension put in tool results and errors.
    'agent-host/src/mcp/session.ts',
    'agent-host/src/mcp/connection.ts',
    'agent-host/src/mcp/pool.ts',
    'agent-host/src/mcp/stdio.ts',
    'agent-host/src/mcp/sign-in.ts',
    // T39: the sandbox note after a failed command, and the proxy's refusal a command prints.
    'agent-host/src/tools/sandbox-report.ts',
    'crates/piarc-sandbox/src/proxy/mod.rs',
    // T46: the review input's labels, and what the model reads when the reviewer refuses.
    'agent-host/src/harness/auto-review.ts',
    'crates/piarc-policy/src/review.rs',
    'crates/piarc-core/src/tool_io/policy/review.rs',
    // T47: the Memory tool's results Core writes, and the index's own lines.
    'agent-host/src/harness/auto-memory.ts',
    'crates/piarc-core/src/tool_io/auto_memory.rs',
    'crates/piarc-core/src/auto_memory.rs',
  ]) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of source.matchAll(literal)) {
      // Interpolations: `${…}` in TypeScript, `{…}` in Rust's format strings.
      const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$?\{[^}]*\}/g, ' ');
      if (words(text).length >= 5) texts.push(text);
    }
  }
  // T37: the built-in slash commands' and output styles' descriptions (the client's catalog).
  const catalog = readFileSync(path.join(repoRoot, 'apps/desktop/src/shared/i18n/en.ts'), 'utf8');
  for (const m of catalog.matchAll(
    /'(?:composer\.command|outputStyle\.builtin)\.[^']+': '((?:[^'\\]|\\.)*)'/g,
  )) {
    texts.push(m[1] ?? '');
  }
  return texts;
}

/** @param {string} text */
function words(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    index: m.index,
  }));
}

async function main() {
  const prompt = render();
  const tokens = words(prompt);
  if (tokens.length < width) throw new Error('PiArc prompt is too short to compare');
  /** @type {Map<string, number[]>} */
  const starts = new Map();
  for (let i = 0; i <= tokens.length - width; i++) {
    const first = tokens[i];
    if (first) starts.set(first.word, [...(starts.get(first.word) ?? []), i]);
  }
  const root = path.join(repoRoot, 'reference', 'claude-code');
  const tracked = await capture('git', ['-C', root, 'ls-files', '-z']);
  /** @type {Set<number>} */
  const hits = new Set();
  let files = 0;
  for (const name of tracked.split('\0').filter(Boolean)) {
    const file = path.join(root, name);
    if (!lstatSync(file).isFile()) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0) || !isUtf8(bytes)) continue;
    files++;
    const reference = words(bytes.toString('utf8').replace(/\\[nrt]/g, ' '));
    for (let j = 0; j <= reference.length - width; j++) {
      for (const i of starts.get(reference[j]?.word ?? '') ?? []) {
        let n = 1;
        while (n < width && tokens[i + n]?.word === reference[j + n]?.word) n++;
        if (n === width) hits.add(i);
      }
    }
  }
  if (files === 0) throw new Error('Reference corpus contains no tracked UTF-8 text');
  console.log(
    `referenceFiles=${String(files)} promptWords=${String(tokens.length)} window=${String(width)} matchingWindows=${String(hits.size)}`,
  );
  for (const i of [...hits].sort((a, b) => a - b)) {
    const lines = prompt.slice(0, tokens[i]?.index).split('\n');
    console.log(
      `PiArc rendered prompt line ${String(lines.length)}, column ${String((lines.at(-1)?.length ?? 0) + 1)}`,
    );
  }
  if (hits.size) process.exitCode = 1;
}

await main();
