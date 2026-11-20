# PiArc 提示词原创性检查

PiArc 的英文身份、基础准则和工具指引按架构第 6.6.1 节、PiArc 自身工具的实际行为编写。Memory 的层级、导入和追加时机来自第 6.6.2 节及官方能力调研的 A6.1、A6.2。源码位于 `agent-host/src/harness/prompts/`。修改这些文本后，在仓库根目录运行：

```sh
node scripts/dev/check-prompt-originality.mjs
```

脚本从当前源码组装包含全部默认工具的完整提示词，覆盖不同平台会采用的工具文案；T26 起另附全部默认工具的描述与 `prompts/notices.ts` 的提醒文案（计划模式开关、任务清单长期未更新）；T27 起再附 hook 上下文、外部修改、后台任务的提醒，压缩后重注入各节的文案，以及 `prompts/compaction.ts` 的摘要请求（system 文本、分节指令、上一摘要与重点说明的写法、文件列表）；T29 起再附保守 Tool Profile 的工具描述与任务清单提醒，以及 `prompts/web-fetch.ts` 的 WebFetch 提取请求（system 文本、提问模板、跨域重定向说明）；R3 起再从源码取出渲染不到的模型可见文字：`agent-host/src/harness/` 与 `src/tools/` 中全部工具参数 schema 的 `description`，以及 `session-memory.ts`、`reminders.ts`、`interruption.ts`、`tool-results.ts` 中五词以上的字符串字面量（模板中的插值换成空白）。工作区路径、日期、用户文档与 git 状态采用空样本，这些内容由运行环境或用户提供。脚本对照本地 `reference/claude-code` 的 Git 跟踪文件，跳过二进制、非 UTF-8 和符号链接。英文大小写归一，按连续字母或数字分词；在参考文本中将转义的换行、制表作为分隔符。逐一比较连续 10 词的滑动窗口，因此超过 10 词的重复也会命中。

T27 的摘要提示另与 Pi 1.5.2 自带的摘要提示（`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/` 的 `compaction.js`、`utils.js`、`branch-summarization.js`）做了一次同样的 10 词窗口比对，0 个匹配窗口：分节结构按架构第 6.15 节"压缩摘要结构"自写，没有沿用 Pi 的标题与措辞。

检查只输出文件数、提示词词数和匹配窗口数。有命中时还输出 PiArc 生成文本上的行列并返回失败。比对在内存中完成，参考文本不执行、不输出、不保存。参考副本位于 gitignore 目录，此命令在具备该副本的本机执行。

下表每行对应一次覆盖范围的扩大，依次为 T22、T26、T27、T29、R3。

| 日期 | 本地参考提交 | 参考文本文件 | PiArc 词数 | 窗口长度 | 匹配窗口 |
|---|---|---:|---:|---:|---:|
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 253 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 1498 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 1967 | 10 | 0 |
| 2026-11-19 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 2656 | 10 | 0 |
| 2026-11-20 | `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 3533 | 3141 | 10 | 0 |
