// Checks that docs/plan/acceptance.json matches the acceptance items written in
// docs/plan/tasks/*.md: same IDs, same task, identical descriptions.
//
// Usage: node scripts/plan/check-acceptance.mjs
// Exit code 0 when consistent, 1 when anything is missing, extra or different.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

/**
 * @typedef {{ id: string, task: string, description: string, source: string }} TaskItem
 * @typedef {{ id: string, task: string, description: string, status: string }} JsonItem
 */

export const tasksDir = path.join(repoRoot, 'docs', 'plan', 'tasks');
export const acceptancePath = path.join(repoRoot, 'docs', 'plan', 'acceptance.json');
export const STATUSES = ['not_started', 'passing', 'failing', 'blocked'];

// `- [T01-A01] description` at the start of a line (list nesting allowed).
const ITEM_LINE = /^\s*- \[([A-Z]+\d+)-(A\d+)\] (.*\S)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TASK_FILE = /^([A-Z]+\d+)-.+\.md$/;

/**
 * Extracts acceptance items from one task file. Lines inside fenced code
 * blocks are ignored. Descriptions are kept verbatim (trailing spaces trimmed).
 * @param {string} markdown
 * @param {string} source file name, used in messages
 * @returns {TaskItem[]}
 */
export function parseTaskItems(markdown, source) {
  /** @type {TaskItem[]} */
  const items = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = ITEM_LINE.exec(line);
    if (match !== null) {
      const [, task = '', number = '', description = ''] = match;
      items.push({ id: `${task}-${number}`, task, description, source });
    }
  }
  return items;
}

/**
 * Validates acceptance.json and returns its items.
 * @param {unknown} raw
 * @returns {{ items: JsonItem[], problems: string[] }}
 */
export function parseAcceptanceJson(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    return { items: [], problems: ['acceptance.json 缺少 items 数组'] };
  }
  /** @type {JsonItem[]} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  for (const [index, item] of raw.items.entries()) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.task !== 'string' ||
      typeof item.description !== 'string' ||
      typeof item.status !== 'string' ||
      typeof item.evidence !== 'string'
    ) {
      problems.push(
        `格式错误：items[${String(index)}] 需要字符串字段 id、task、description、status、evidence`,
      );
      continue;
    }
    if (!STATUSES.includes(item.status)) {
      problems.push(
        `状态无效：${item.id} 的 status 为 "${item.status}"，应为 ${STATUSES.join('、')}`,
      );
    }
    items.push({
      id: item.id,
      task: item.task,
      description: item.description,
      status: item.status,
    });
  }
  return { items, problems };
}

/**
 * Compares task-file items with acceptance.json items.
 * @param {TaskItem[]} taskItems
 * @param {JsonItem[]} jsonItems
 * @returns {string[]}
 */
export function compareItems(taskItems, jsonItems) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, TaskItem>} */
  const fromTasks = new Map();
  for (const item of taskItems) {
    const previous = fromTasks.get(item.id);
    if (previous !== undefined) {
      problems.push(`重复：${item.id} 在 ${previous.source} 与 ${item.source} 中都出现`);
      continue;
    }
    fromTasks.set(item.id, item);
  }
  /** @type {Map<string, JsonItem>} */
  const fromJson = new Map();
  for (const item of jsonItems) {
    if (fromJson.has(item.id)) {
      problems.push(`重复：${item.id} 在 acceptance.json 中出现多次`);
      continue;
    }
    fromJson.set(item.id, item);
  }

  for (const [id, item] of fromTasks) {
    const json = fromJson.get(id);
    if (json === undefined) {
      problems.push(`缺失：${id}（${item.source}）不在 acceptance.json 中`);
      continue;
    }
    if (json.task !== item.task) {
      problems.push(
        `task 不一致：${id} 在 acceptance.json 中为 "${json.task}"，应为 "${item.task}"`,
      );
    }
    if (json.description !== item.description) {
      problems.push(
        `描述不一致：${id}（${item.source}）\n` +
          `    任务文件：${item.description}\n` +
          `    acceptance.json：${json.description}`,
      );
    }
  }
  for (const id of fromJson.keys()) {
    if (!fromTasks.has(id)) {
      problems.push(`多余：${id} 在 acceptance.json 中，但没有任何任务文件定义它`);
    }
  }
  return problems;
}

/**
 * Reads every task file and checks that each item ID belongs to its file.
 * @param {string} dir
 * @returns {{ items: TaskItem[], problems: string[] }}
 */
export function readTaskItems(dir) {
  /** @type {TaskItem[]} */
  const items = [];
  /** @type {string[]} */
  const problems = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  for (const file of files) {
    const fileTask = TASK_FILE.exec(file)?.[1];
    const fileItems = parseTaskItems(readFileSync(path.join(dir, file), 'utf8'), file);
    for (const item of fileItems) {
      if (fileTask !== item.task) {
        problems.push(`编号与文件不符：${item.id} 写在 ${file} 中`);
      }
    }
    items.push(...fileItems);
  }
  return { items, problems };
}

function main() {
  const tasks = readTaskItems(tasksDir);
  const json = parseAcceptanceJson(readJsonFile(acceptancePath));
  const problems = [...tasks.problems, ...json.problems, ...compareItems(tasks.items, json.items)];
  if (problems.length > 0) {
    console.error(`验收清单检查失败（${String(problems.length)} 个问题）：`);
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`验收清单检查通过：${String(json.items.length)} 个验收项与任务文件一致。`);
}

if (isMain(import.meta.url)) {
  main();
}
