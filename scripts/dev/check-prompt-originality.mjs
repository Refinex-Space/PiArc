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
        const system = assembleSystem(CANONICAL_TOOLS, DEFAULT_PROFILE, [],
          {cwd: '', platform: '', date: '', gitStatus: ''}).text;
        const conservative = conservativeProfile(DEFAULT_PROFILE);
        const descriptions = CANONICAL_TOOLS.flatMap((tool) =>
          // T29: the conservative profile's own descriptions too.
          [...new Set([DEFAULT_PROFILE[tool].description, conservative[tool].description])]);
        const todo = [{ content: '', status: 'pending' }];
        const notices = [notice.PLAN_ON,
          ...['default', 'acceptEdits', 'bypassPermissions'].map(notice.planOff),
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
          sub.partialReport(0, ''), sub.EMPTY_REPORT, sub.toolNotAvailable('')];
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
 * result budget and the subagent runs (T31) write. */
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
    'harness/session-memory.ts',
    'harness/reminders.ts',
    'harness/interruption.ts',
    'harness/tool-results.ts',
    'runtime/subagents.ts',
    'runtime/subagent-session.ts',
  ]) {
    const source = readFileSync(path.join(repoRoot, 'agent-host/src', file), 'utf8');
    for (const m of source.matchAll(literal)) {
      const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      if (words(text).length >= 5) texts.push(text);
    }
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
