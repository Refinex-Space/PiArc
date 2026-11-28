# scripts/l3

L3 行为对齐（T30，架构第 12.5 节，ADR-0046）：`npm run l3` 的实现。完整说明在 `docs/engineering/testing.md` 第 14 节。

## 模块

| 文件 | 职责 |
|---|---|
| `run.mjs` | 一条命令的全流程、对照覆盖检查（`COMPARED_L2_PREFIXES`）与退出码 |
| `scenario.mjs` | 场景加载、`PARAMETERS`（Claude Code ↔ PiArc 参数映射）、转成 L2 场景、mock 脚本 |
| `claude-side.mjs` | 隔离运行 `claude -p`，stream-json 只在内存中读 |
| `recording.mjs`、`check-recordings.mjs` | 录制产物格式与路径占位；白名单 schema 与自然语言扫描 |
| `normalize.mjs`、`diff.mjs`、`allowlist.mjs`、`report.mjs` | 比较文档、字段路径 diff 与模式、allowlist、报告 |
| `files.mjs`、`home-snapshot.mjs` | 工作区文件指纹（与 `piarc_testkit::l3::file_hash` 同一算法）与 JSON lines；运行前后 `~/.claude` 与 `~/.claude.json` 的快照比较（同时开着的 Claude Code 会话写会话记录也会被报告） |
| `fixtures/hook.mjs`、`fixtures/approval-server.mjs` | 两侧共用的 hook 夹具（复制成工作区的 `.l3/hook.mjs`）、Claude Code 的审批 MCP server |

## 不变量

- 任何写盘、打印的内容只来自录制产物的白名单结构；Claude Code 的 stream-json、请求体与 hook 原始输入只在内存或临时根中，临时根运行后删除。夹具只记字段名与决定。
- 两侧的差异只经 `diff` 与 allowlist 表达，不在归一化里为某个场景特判；能用 allowlist 说明的偏离不改归一化。
- 新的比较维度先确认两侧都能稳定给出（`--repeat 2`），再加进 `normalize.mjs`。

## 易错点

- 场景的 Bash 命令避开两边的只读白名单（用 `touch`、`mkdir`），否则不会询问；Claude Code 把 `sed -n` 当只读，PiArc 不把它当只读。
- 场景里不要写会删除文件或联网的命令：一侧不询问时它会真的执行。
- Claude Code 会把 Edit 的 `replace_all: false` 默认值写回历史；新增工具参数映射时注意这类回填。
- `fixtures/` 下的 `.mjs` 也受 ESLint 与 `tsc` 检查；`fixtures/recordings/` 的夹具正文是自写的，不能拷贝任何真实提示词。
