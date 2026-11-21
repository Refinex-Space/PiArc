# piarc-git

git 的状态、diff、worktree、分支。T13：目录所属仓库的主 checkout（`checkout::resolve`），它是项目信任的键。T35：PiArc 的 worktree（`worktree`）与运行 git 的 `Git`（`git`）。不存信任、不判定信任、不决定何时清理（`piarc-core::worktrees`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-git` | 单元测试 + `tests/checkout.rs`（真实 git 夹具：linked worktree、submodule、非 git 目录、符号链接、大小写）+ `tests/worktree.rs`（T35：创建、基础分支、`.worktreeinclude`、`.gitignore` 行、改动、移除保留分支、重建、子 agent 分支） |

## 主 checkout 解析规则

从目录向上找第一个 `.git`：

| `.git` | 情况 | 信任键 |
|---|---|---|
| 目录 | 普通仓库 | 仓库根 |
| 文件，`gitdir` 下有 `commondir` | linked worktree | `commondir` 指向的主仓库 git 目录的父目录（git 目录不叫 `.git` 时，如 bare 或分离的 git 目录，用 git 目录本身） |
| 文件，没有 `commondir` | submodule 或分离 git 目录的仓库 | 含 `.git` 文件的目录（独立项目） |
| 一直找不到 | 非 git 目录 | 目录自身 |

- 路径一律经 `canonical`：解析符号链接、取磁盘上的大小写、去掉 Windows `\\?\` 前缀（`strip_verbatim`）。比较与存储都用规范路径。
- 读取 `.git`、`commondir` 并校验主仓库 worktrees 登记的 `gitdir` 反向指针，不启动 git 进程。

## Worktree（T35，ADR-0052）

- 位置与命名：`<仓库顶层>/.piarc/worktrees/<名称>/`，分支 `piarc/<名称>`；名称 1–64 个 `[A-Za-z0-9._-]`、以字母或数字开头、不含 `..`、不以 `.` 或 `.lock` 结尾（`check_name`）。会话缺省名是会话 id 前 8 位，子 agent 是 `agent-<子会话 id 前 8 位>`。`create` 要求目录是 `git rev-parse --show-toplevel`，基础先解析成提交（`rev-parse --verify --end-of-options <基础>^{commit}`）再交给 `worktree add -b`，参数注入不到 git。
- `.worktreeinclude`：`ls-files --others --ignored --exclude-from=<文件>` 列出候选，再经 `check-ignore -z --stdin` 留下被 git 忽略的；只复制普通文件，跳过符号链接、已存在的目标和 `.piarc/worktrees/` 下的内容。复制失败时把刚建的 worktree 强制删掉。
- 改动：`status --porcelain=v1 -z --untracked-files=all`，被忽略的文件不算改动（复制进来的 `.env` 不会让 worktree 变"脏"）。
- 清理只删目录与 git 的登记（`worktree remove`），分支保留；不带 `force` 时 git 拒绝有改动的 worktree，调用方的检查与删除之间的竞态由 git 兜底。目录已不在时只 `worktree prune`。子 agent 的分支用 `update-ref -d refs/heads/<分支> <基础提交>` 删除：分支动过就删不掉。
- `head_branch` 读 `.git`（文件或目录）与 `HEAD`，不起进程，快照与环境栏用它。
- `Git` 经注入的 `ProcessSpawner` 运行（生产是 `piarc-exec` 的进程树启动器），环境由调用方给（Core 用命令环境），另加 `GIT_TERMINAL_PROMPT=0`；超时默认 300 s，超时即杀。stdin 写完即关。`find_program` 只认 `PATH` 中的绝对目录，排除工作区内的 git。

## 扩展包（`package`，T40）

- `clone_pinned(git, url, dir)`：URL 放在 `--` 之后克隆，检出为分离 HEAD 并返回提交（失败时删掉目录）；`update_pinned` 取 `origin/HEAD`（没有时 `FETCH_HEAD`）并重新检出，返回新旧提交。位置与内容由 Core 与 `piarc-config` 决定。

## 易错点

- `tests/worktree.rs` 自带一个 tokio 的最小启动器（功能 crate 不能依赖 `piarc-exec`），Windows 上同样能跑。
- 测试里的 git 用 `-c user.name/-c user.email/-c commit.gpgsign=false/-c protocol.file.allow=always` 与 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（Windows 为 `NUL`），不依赖本机配置；本地路径的 `submodule add` 需要 `protocol.file.allow=always`。

## 参考

- 架构第 10.2 节；`crates/piarc-core/src/trust.rs`。
