# piarc-diff

文件变更的 diff（架构第 7.7 节，ADR-0027）：`file_diff(label, old, new)` 用 similar 计算行级 diff，给出 `piarc_protocol::diff::FileDiff`（unified 文本、hunk、增删行数）。`piarc-core::tool_io` 在每次 `fs/write` 后调用它，结果随 `fs/write` 的响应交给 Agent Host，再进入 `fileChange` 条目。不读文件、不渲染。T28 起 Changes 面板也用它（基线对当前内容），并用 `revert_hunks` 丢弃单个 hunk。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-diff` | 单元测试：上下文与 hunk 范围、新建文件、末行无换行、CRLF、删空文件、降级与按字符边界截断 |
| `cargo clippy -p piarc-diff --all-targets -- -D warnings` | lint |

## 约定

- hunk 范围按 unified diff：从 1 计；行数为 0 的一侧，起点是它之前的那一行（新文件为 `@@ -0,0 +1,n @@`）。范围为 1 行时 unified 文本只写起点（GNU diff 的写法）。
- 行文本不含 `\n`、`\r\n`；文件末行没有换行时该行 `noNewline`，unified 文本跟一行 `\ No newline at end of file`。
- unified 预览与 hunk 在一次遍历中使用同一组变更行，预览写入时即执行字节预算，不用 similar 的 `unified_diff()`，两者因此总是一致。
- 增删合计超过 `MAX_HUNK_LINES`（5,000）或文本超过 `MAX_UNIFIED_BYTES`（512 KiB）时降级：不给 hunk，文本截断并注明，增删行数仍然准确。similar 的搜索限时 2 秒，超时后给出较粗的 diff，不报错。
- 调用方负责去掉 BOM（`piarc_fs::write` 给的新旧文本都不带 U+FEFF），所以保留 BOM 的编辑不会显示成第一行的变化。

- `revert_hunks(current, hunks)`（Changes 面板按 hunk 丢弃，ADR-0044 第 8 条）：逐行核对每个 hunk 的新侧与当前文本，不符报 `RevertError`（Core 映射为"文件已变化"）；多个 hunk 自下而上应用，所以前面的偏移不受影响；恢复的行沿用相邻行的换行符，没有相邻行时取文件中出现的第一种换行（都没有为 `\n`）。不要在别处重算 diff 再反向应用。
- 面板整体降级阈值 `MAX_PANEL_FILES`（300 个文件）、`MAX_PANEL_LINES`（合计 5,000 行增删）在本 crate，单文件降级仍按 `MAX_HUNK_LINES`、`MAX_UNIFIED_BYTES`。

## 易错点

- similar 3 需要 `std` 特性才有 `timeout`/`deadline`（工作区依赖已开）。
- 词级 diff 与 UTF-16 偏移还没有：T28 的 Changes 面板按行显示、按 hunk 丢弃，T42 的行内评论按行号范围与摘录在渲染进程定位（`apps/desktop/src/renderer/changes/comments.ts`），都没有用到它们。
