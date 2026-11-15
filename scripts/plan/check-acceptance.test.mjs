import { describe, expect, it } from 'vitest';
import { compareItems, parseAcceptanceJson, parseTaskItems } from './check-acceptance.mjs';

const markdown = [
  '# T09 示例任务',
  '',
  '## 验收标准',
  '',
  '- [T09-A01] 渲染 `Markdown`（含代码块、表格），滚动"跟随"正确；验证：Playwright 截图（`tmp/evidence/T09/`）。',
  '- [T09-A02] 输入法组合期间按 Enter 不发送：中文标点，、；：！？《》…… 均保留。   ',
  '  - [T09-A03] 嵌套列表中的验收项也被识别 (half-width parens) [brackets] {braces}.',
  '- 普通列表项 [T09-A99] 不在行首，不算验收项',
  '',
  '```markdown',
  '- [T09-A98] 代码块中的示例不算验收项',
  '```',
].join('\r\n');

const parsed = parseTaskItems(markdown, 'T09-example.md');

/**
 * @param {string} id
 * @param {string} description
 * @param {string} [task]
 */
function jsonItem(id, description, task = 'T09') {
  return { id, task, description, status: 'not_started' };
}

describe('parseTaskItems', () => {
  it('extracts IDs and verbatim descriptions with backticks, brackets and Chinese punctuation', () => {
    expect(parsed.map((item) => item.id)).toEqual(['T09-A01', 'T09-A02', 'T09-A03']);
    expect(parsed[0]?.description).toBe(
      '渲染 `Markdown`（含代码块、表格），滚动"跟随"正确；验证：Playwright 截图（`tmp/evidence/T09/`）。',
    );
    expect(parsed[1]?.description).toBe(
      '输入法组合期间按 Enter 不发送：中文标点，、；：！？《》…… 均保留。',
    );
    expect(parsed[2]?.description).toBe(
      '嵌套列表中的验收项也被识别 (half-width parens) [brackets] {braces}.',
    );
    expect(parsed.every((item) => item.task === 'T09' && item.source === 'T09-example.md')).toBe(
      true,
    );
  });

  it('recognises W and R series IDs', () => {
    const items = parseTaskItems('- [W0-A01] Windows 项\n- [R1-A12] 评审项', 'x.md');
    expect(items.map((item) => [item.id, item.task])).toEqual([
      ['W0-A01', 'W0'],
      ['R1-A12', 'R1'],
    ]);
  });
});

describe('compareItems', () => {
  const json = parsed.map((item) => jsonItem(item.id, item.description));

  it('passes when IDs, tasks and descriptions match', () => {
    expect(compareItems(parsed, json)).toEqual([]);
  });

  it('reports a changed description', () => {
    const changed = json.map((item) =>
      item.id === 'T09-A02' ? { ...item, description: `${item.description}。` } : item,
    );
    const problems = compareItems(parsed, changed);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^描述不一致：T09-A02/);
  });

  it('reports missing and extra items', () => {
    const edited = [...json.filter((item) => item.id !== 'T09-A01'), jsonItem('T09-A04', '新增')];
    expect(compareItems(parsed, edited)).toEqual([
      '缺失：T09-A01（T09-example.md）不在 acceptance.json 中',
      '多余：T09-A04 在 acceptance.json 中，但没有任何任务文件定义它',
    ]);
  });

  it('reports a task mismatch and duplicates', () => {
    const edited = [
      jsonItem('T09-A01', parsed[0]?.description ?? '', 'T10'),
      ...json.slice(1),
      json[2],
    ];
    const problems = compareItems(
      [...parsed, ...parsed.slice(0, 1)],
      edited.filter((x) => x !== undefined),
    );
    expect(problems).toContain('重复：T09-A01 在 T09-example.md 与 T09-example.md 中都出现');
    expect(problems).toContain('重复：T09-A03 在 acceptance.json 中出现多次');
    expect(problems).toContain('task 不一致：T09-A01 在 acceptance.json 中为 "T10"，应为 "T09"');
  });
});

describe('parseAcceptanceJson', () => {
  it('rejects unknown statuses and malformed items', () => {
    const result = parseAcceptanceJson({
      items: [
        { id: 'T09-A01', task: 'T09', description: 'x', status: 'done', evidence: '' },
        { id: 'T09-A02', task: 'T09' },
      ],
    });
    expect(result.items.map((item) => item.id)).toEqual(['T09-A01']);
    expect(result.problems).toEqual([
      '状态无效：T09-A01 的 status 为 "done"，应为 not_started、passing、failing、blocked',
      '格式错误：items[1] 需要字符串字段 id、task、description、status、evidence',
    ]);
  });
});
