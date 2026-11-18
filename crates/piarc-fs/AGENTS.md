# piarc-fs

Core 侧的文件操作：AHP `fs/*` 背后的实现（架构第 6.1.2、6.1.3 节，ADR-0027），以会话 `Scope` 为单位的阻塞函数，由 `piarc-core::tool_io` 放到 tokio 的阻塞线程池上调用。本 crate 就是文件 I/O 的实现，所以直接用 `std::fs`。负责：路径边界与受保护路径的标记（`access`）、文件状态表与路径锁（`state`）、编码检测与编解码（`encoding`）、保真的原子写入（`write`、`atomic`）、过长结果落盘（`spill`）、PDF 文本（`pdf`）、glob 与 grep、`watch`（notify 的目录监听，T13）。不负责权限裁决（需要询问的操作只标记，Core 的 `tool_io::files::adjudicate` 决定）、快照（`piarc-checkpoint`）、diff（`piarc-diff`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-fs` | 单元测试：路径与访问检查（符号链接、受保护路径、大小写）、状态表与路径锁、编码与按范围解码、原子替换与注入的写入失败、写入不变量、spill、PDF、glob、grep |
| `cargo clippy -p piarc-fs --all-targets -- -D warnings` | lint |

Core 层的集成测试在 `crates/piarc-core/tests/tool_io.rs`（越界、会话隔离）与 `tests/file_invariants.rs`（状态表、上传与 diff、受保护路径、spill、编码）。

## 路径规范化与边界（`Scope`）

1. 相对路径接到 cwd 上（接到 cwd 的非 `\\?\` 写法上：Windows 在 `\\?\` 前缀下不把 `/` 当分隔符）。
2. 按词法去掉 `.`、`..`（与 Node 的 `path.resolve` 一致；`..` 停在根）。
3. 存在的部分由操作系统规范化（解析符号链接；macOS 与 Windows 的 `canonicalize` 都返回磁盘上的大小写）；悬空的符号链接按目标继续解析，最多 40 跳，超出报 `ELOOP`；不存在的尾部原样接上。
4. `Scope::check(path, Access)`：读允许工作区根、已添加目录（`with_added_dir`）与只读目录（`with_read_only_dir`，会话临时目录）；写只允许前两者，且路径的任一组件不能是 `.git`、`.piarc`、`.claude`、`.pi`，文件名不能是 shell 配置文件（`access::SHELL_CONFIG_FILES`）。否则 `Error::NeedsApproval`，不触碰目标。`Scope::resolve` 保留命令工作目录的边界（`OutsideWorkspace`）。
5. 状态表的键 `Scope::key`：`display()` 后的路径，根所在的卷大小写不敏感时整体转小写。是否不敏感在 `Scope::new` 时探测一次：把根路径中最深的含 ASCII 字母的组件换大小写，看是否指向同一目录。

## 阈值与常量

`MAX_READ_CHUNK`、`MAX_BLOB_BYTES`（32 MiB）、`MAX_UPLOAD_BYTES`（64 MiB）在 `piarc_protocol::fs`；`DETECT_BYTES`（编码检测看前 8 MiB）在 `content.rs`；PDF 的 `MAX_PAGES_WITHOUT_RANGE`（10）、`MAX_PAGES_PER_READ`（20）在 `pdf.rs`。工具结果的 50K/200K 不在这里，在 `agent-host/src/harness/tool-results.ts`。

## 不变量

- 每个公开操作先 `scope.check`（命令的工作目录用 `scope.resolve`），再碰文件系统；新增操作照此办理。
- 替换已存在的文件只经 `write()`：路径锁内检查新鲜度 → 解码旧文本 → 编码新文本 → `atomic::replace` → 登记写入。新鲜度以内容哈希判断，不看 mtime。不要另写直接 `std::fs::write` 的路径。
- 写回用旧文件的编码与 BOM（`encoding::encode` 去掉文本开头的 U+FEFF，换成该编码的 BOM）；`LineEndings::MatchFile` 才改换行。新文件 UTF-8 无 BOM。编码检测只在不是 UTF-8 时启用；含 NUL 的内容按二进制，以 UTF-8 加 U+FFFD 读。
- 按范围读不切断字符：UTF-8 按 `piarc_protocol::text`，其他编码按 `encoding::decode_range`（比较 `last` 与否的解码结果找出被切断的字符）。
- 结果里的路径用 `display()`（去掉 `\\?\`）；错误码用 POSIX 风格的名字，各平台一致。`NotRead`、`Modified`、`NeedsApproval`、`Unencodable` 的消息写给模型看：发生了什么、下一步做什么。

## 易错点

- 同一监听器一次注册多个根时使用 `Watcher::watch_dirs`。notify 8.2.1 的 macOS 后端每次单独 `watch` 都会停止并重新启动 FSEvents 流。批量更新必须 `commit`，原有根全部已在监听时无需更新。

- `fuzzy::list_files` 与 `rank` 为工作区文件提及提供相对路径。文件名排序的 `positions` 按 Unicode 字符计数，和输入消息中提及的 UTF-16 区间单位不同。Core 负责结果缓存和取消（ADR-0030）。

- Windows 上 `std::fs::rename` 覆盖已存在的文件：Win10 1607 以上用 `FileRenameInfoEx`（POSIX 语义），否则 `MoveFileExW`。目标被别的进程以不共享删除的方式打开（杀毒、索引）时短暂拒绝访问，`atomic::rename` 在 Windows 上重试 5 次。替换不保留 ACL 与备用数据流，只带上隐藏、系统属性；Unix 上带上原权限位。只读文件一律 `EACCES`（Unix 的 rename 本可以覆盖它）。
- rename 会断开硬链接：其他名字仍是旧内容。
- 含非法序列的 UTF-8 文件经编辑后，这些字节变成 U+FFFD（整文件按 UTF-8 解码再编码）。
- PDF 用 lopdf 0.46 的 `extract_text_with_limit`：资源以内联字典写在页树节点上（被页面继承）时取不到文字（I71）。`pdf-extract` 不能用：它锁 lopdf 0.42，引入已停止维护的 `ttf-parser`，cargo-deny 拒绝。测试 PDF 用 `pdf/tests.rs` 的 `make_pdf` 生成。
- glob 的 `.gitignore` 在 Git 仓库外也生效（Pi 给 fd 传 `--no-require-git`），grep 的只在仓库内生效（ripgrep 默认）：两者故意不同，对照测试依赖这一点。L2 场景用 `.git/HEAD` 标出仓库。
- `io::ErrorKind::FilesystemLoop` 在稳定版还不能具名使用，`ELOOP` 按其 `Debug` 名识别。
- 单元测试的临时目录名必须各不相同：同名的 `TempTree` 在并行测试里会互相删除。
