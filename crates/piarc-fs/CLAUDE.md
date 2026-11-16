# piarc-fs

Core 侧的文件操作：AHP `fs/*` 背后的实现（架构第 6.1.3 节），以会话 `Scope`（工作区根 + cwd）为单位的阻塞函数，由 `piarc-core::tool_io` 放到 tokio 的阻塞线程池上调用。本 crate 就是文件 I/O 的实现，所以直接用 `std::fs`。不负责权限裁决（`piarc-policy`）、快照（`piarc-checkpoint`）、diff（`piarc-diff`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-fs` | 单元测试：路径限定（含符号链接、悬空链接、环）、按范围读、blob、写与追加、stat 与图片嗅探、list、glob、grep |
| `cargo clippy -p piarc-fs --all-targets -- -D warnings` | lint |

越界与会话隔离的集成测试在 `crates/piarc-core/tests/tool_io.rs`。

## 路径限定（`Scope::resolve`）

1. 相对路径接到 cwd 上（接到 cwd 的非 `\\?\` 写法上：Windows 在 `\\?\` 前缀下不把 `/` 当分隔符）。
2. 按词法去掉 `.`、`..`（与 Node 的 `path.resolve` 一致；`..` 停在根）。
3. 存在的部分由操作系统规范化（解析符号链接、取磁盘上的大小写）；悬空的符号链接按目标继续解析，最多 40 跳，超出报 `ELOOP`；不存在的尾部原样接上。
4. 结果必须以工作区根为前缀（按组件比较，两边都是规范路径），否则返回 `OutsideWorkspace`，不触碰目标。

检查与操作不是原子的（符号链接替换的竞态由 T16 与沙箱收窄）。T16 会把越界从"拒绝"改为"询问"。

## 不变量

- 每个公开操作先 `scope.resolve`，再碰文件系统；新增操作照此办理。
- 结果里的路径用 `display()`（去掉 `\\?\`）；错误码用 POSIX 风格的名字（`ENOENT`、`EACCES`、`EISDIR`……），各平台一致，Agent Host 据此重建 Node 风格的错误文字。
- 文本按范围读（每次最多 `MAX_READ_CHUNK` = 1 MiB），不切断 UTF-8 序列（规则在 `piarc_protocol::text`）；非法 UTF-8 变为 U+FFFD。二进制走 `read_blob`：按 SHA-256 复制到调用方给的 blob 目录，先写临时名再 rename。
- glob 对齐 `fd --glob --hidden`（Pi 原生 find 的行为），grep 对齐 `rg --json --hidden` 与 Pi grep 的匹配上限规则；两者都按路径排序输出。规则细节在各自的模块文档。

## 易错点

- glob 的 `.gitignore` 在 Git 仓库外也生效（Pi 给 fd 传 `--no-require-git`），grep 的只在仓库内生效（ripgrep 默认）：两者故意不同，对照测试依赖这一点。
- `io::ErrorKind::FilesystemLoop` 在稳定版还不能具名使用，`ELOOP` 按其 `Debug` 名识别。
- 单元测试的临时目录名必须各不相同：同名的 `TempTree` 在并行测试里会互相删除。
