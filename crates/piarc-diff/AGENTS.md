# piarc-diff

文件变更的 diff（架构第 7.7 节，ADR-0027）：`file_diff(label, old, new)` 用 similar 计算行级 diff，给出 `piarc_protocol::diff::FileDiff`（unified 文本、hunk、增删行数）。`piarc-core::tool_io` 在每次 `fs/write` 后调用它，结果随 `fs/write` 的响应交给 Agent Host，再进入 `fileChange` 条目。不读文件、不渲染。

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

## 易错点

- similar 3 需要 `std` 特性才有 `timeout`/`deadline`（工作区依赖已开）。
- 词级 diff 与 UTF-16 偏移还没有：Changes 面板（T28）需要时在这里补，不在渲染进程里另算。
