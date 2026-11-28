// Adapted from Markdown Studio's livePreview/catalog.ts (e6ebd0c, Apache-2.0).
// Labels are translated by the owning editor. Search accepts Markdown, Chinese and pinyin.
import type { EditorState } from '@codemirror/state';
import type { MessageId } from '../../../shared/i18n/index.js';
import type { FormatCommand } from './formatting.js';
import { imagePort } from './image-import.js';
import { hostOf } from './widget-host.js';

export type Item = FormatCommand | 'image';
export type Folder = 'diagram' | 'callout';
export type Section = 'basic' | 'lists' | 'insert';
export interface SlashItem {
  id: Item;
  label: MessageId;
  section: Section;
  icon: string;
  hint: string;
  keywords: string;
  folder?: Folder;
  searchOnly?: boolean;
}
export interface FolderItem {
  folderId: Folder;
  label: MessageId;
  children: SlashItem[];
  icon: string;
}
export type Entry = SlashItem | FolderItem;
export interface Group {
  section?: Section;
  items: Entry[];
}

const catalog: readonly SlashItem[] = [
  {
    id: 'paragraph',
    section: 'basic',
    label: 'md.edit.paragraph',
    icon: '¶',
    hint: '',
    keywords: 'paragraph text plain body zhengwen zw duanluo dl 正文 段落',
  },
  ...(
    [
      ['h1', 'yi'],
      ['h2', 'er'],
      ['h3', 'san'],
      ['h4', 'si'],
      ['h5', 'wu'],
      ['h6', 'liu'],
    ] as const
  ).map(([id, ordinal], index): SlashItem => {
    const level = index + 1;
    return {
      id,
      section: 'basic',
      label: `md.edit.${id}`,
      icon: id.toUpperCase(),
      hint: '#'.repeat(level),
      keywords: `${id} heading${String(level)} heading title biaoti bt ${ordinal}jibiaoti ${ordinal.charAt(0)}jbt 标题`,
      searchOnly: level > 3,
    };
  }),
  {
    id: 'bullet',
    section: 'lists',
    label: 'md.edit.bullet',
    icon: '☷',
    hint: '-',
    keywords: 'unordered list ul bullet wuxuliebiao wxlb liebiao lb 列表',
  },
  {
    id: 'ordered',
    section: 'lists',
    label: 'md.edit.ordered',
    icon: '1.',
    hint: '1.',
    keywords: 'ordered numbered ol youxuliebiao yxlb liebiao lb 编号',
  },
  {
    id: 'task',
    section: 'lists',
    label: 'md.edit.task',
    icon: '☑',
    hint: '[ ]',
    keywords: 'task checkbox checklist todo renwu rw daiban db 待办 任务 清单',
  },
  {
    id: 'quote',
    section: 'lists',
    label: 'md.edit.quote',
    icon: '❝',
    hint: '>',
    keywords: 'quote blockquote yinyong yy 引用',
  },
  {
    id: 'table',
    section: 'insert',
    label: 'md.edit.table',
    icon: '▦',
    hint: '| |',
    keywords: 'table grid biaoge bg 表格',
  },
  {
    id: 'fence',
    section: 'insert',
    label: 'md.edit.fence',
    icon: '‹›',
    hint: '```',
    keywords: 'code block codeblock fence snippet daima dm daimakuai dmk 代码',
  },
  {
    id: 'formula',
    section: 'insert',
    label: 'md.edit.formula',
    icon: 'ƒ',
    hint: '$$',
    keywords: 'math latex katex formula equation tex gongshi gs shuxue sx 公式 数学',
  },
  {
    id: 'rule',
    section: 'insert',
    label: 'md.edit.rule',
    icon: '―',
    hint: '---',
    keywords: 'rule divider hr separator fengexian fgx 分割线 分隔线',
  },
  {
    id: 'link',
    section: 'insert',
    label: 'md.edit.link',
    icon: '↗',
    hint: '[]()',
    keywords: 'url href link lianjie lj 链接',
  },
  {
    id: 'footnote',
    section: 'insert',
    label: 'md.slash.footnote',
    icon: '¹',
    hint: '[^1]',
    keywords: 'footnote reference jiaozhu jz 脚注',
  },
  {
    id: 'frontMatter',
    section: 'insert',
    label: 'md.slash.frontMatter',
    icon: '≡',
    hint: '---',
    keywords: 'frontmatter yaml metadata yuanshuju ysj 属性 元数据',
    searchOnly: true,
  },
  {
    id: 'image',
    section: 'insert',
    label: 'md.edit.insertImage',
    icon: '▧',
    hint: '![]()',
    keywords: 'image picture img photo tupian tp 图片',
  },
  ...(
    [
      ['note', 'zhuyi zy 注意'],
      ['tip', 'jiqiao jq 技巧'],
      ['important', 'zhongyao zy 重要'],
      ['warning', 'jinggao jg 警告'],
      ['caution', 'danger weixian wx 危险'],
    ] as const
  ).map(([kind, aliases]): SlashItem => ({
    id: `callout-${kind}`,
    label: `files.md.callout.${kind}`,
    section: 'insert',
    folder: 'callout',
    icon: '!',
    hint: `[!${kind.toUpperCase()}]`,
    keywords: `callout alert admonition tishi ts 提示 ${kind} ${aliases}`,
  })),
  ...(
    [
      ['flowchart', 'flow graph liuchengtu lct 流程图'],
      ['sequence', 'shixutu sxt 时序图'],
      ['class', 'uml leitu lt 类图'],
      ['state', 'zhuangtaitu ztt 状态图'],
      ['er', 'entity relationship database shitiguanxi stgx 实体关系'],
      ['gantt', 'schedule gantetu gtt 甘特图'],
      ['pie', 'bingtu bt 饼图'],
      ['mindmap', 'mind siweidaotu swdt 思维导图'],
    ] as const
  ).map(([kind, aliases]): SlashItem => ({
    id: `diagram-${kind}`,
    label: `md.slash.${kind}`,
    section: 'insert',
    folder: 'diagram',
    icon: '◇',
    hint: 'mermaid',
    keywords: `mermaid diagram chart tubiao tb 图表 ${kind} ${aliases}`,
  })),
  {
    id: 'bold',
    section: 'basic',
    label: 'md.edit.bold',
    icon: 'B',
    hint: '**',
    keywords: 'bold strong jiacu jc 加粗',
    searchOnly: true,
  },
  {
    id: 'italic',
    section: 'basic',
    label: 'md.edit.italic',
    icon: 'I',
    hint: '*',
    keywords: 'italic emphasis xieti xt 斜体',
    searchOnly: true,
  },
  {
    id: 'strike',
    section: 'basic',
    label: 'md.edit.strike',
    icon: 'S',
    hint: '~~',
    keywords: 'strikethrough strike shanchuxian scx 删除线',
    searchOnly: true,
  },
  {
    id: 'inlineCode',
    section: 'basic',
    label: 'md.edit.inlineCode',
    icon: '‹›',
    hint: '`',
    keywords: 'inline code 行内代码',
    searchOnly: true,
  },
];

function matchScore(item: SlashItem, query: string, state: EditorState) {
  const terms = [hostOf(state).t(item.label), item.id, item.hint, ...item.keywords.split(' ')];
  let best = 0;
  for (const term of terms) {
    const value = term.toLowerCase().replace(/\s+/gu, '');
    if (value === query) return 100;
    if (value.startsWith(query)) best = Math.max(best, 80);
    else if (query.length > 1 && value.includes(query)) best = Math.max(best, 50);
  }
  return best;
}

export function slashGroups(state: EditorState, raw: string): Group[] {
  const query = raw.toLowerCase().replace(/\s+/gu, '');
  const items = catalog.filter(
    (item) => item.id !== 'image' || state.facet(imagePort)[0]?.().chooseImage,
  );
  if (query) {
    const ranked = items
      .map((item) => ({ item, score: matchScore(item, query, state) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((match) => match.item);
    return ranked.length ? [{ items: ranked }] : [];
  }
  return (['basic', 'lists', 'insert'] as const).map((section) => {
    const rows: Entry[] = [];
    const folders = new Map<Folder, FolderItem>();
    for (const item of items) {
      if (item.section !== section || item.searchOnly) continue;
      if (!item.folder) {
        rows.push(item);
        continue;
      }
      let row = folders.get(item.folder);
      if (!row) {
        row = {
          folderId: item.folder,
          label: item.folder === 'diagram' ? 'md.edit.diagram' : 'md.slash.callout',
          icon: item.icon,
          children: [],
        };
        folders.set(item.folder, row);
        rows.push(row);
      }
      row.children.push(item);
    }
    return { section, items: rows };
  });
}
