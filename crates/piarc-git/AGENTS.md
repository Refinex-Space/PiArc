# piarc-git

git 的状态、diff、worktree、分支。T13：目录所属仓库的主 checkout（`checkout::resolve`），它是项目信任的键。T35：PiArc 的 worktree（`worktree`）与运行 git 的 `Git`（`git`）。ADR-0084、ADR-0085：Git 工具的查询与写操作（`repo`、`status`、`diff`、`log`、`refs`、`index`、`commit`、`branches`、`remote`）。不存信任、不判定信任、不决定何时清理（`piarc-core::worktrees`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-git` | 单元测试 + `tests/checkout.rs`（真实 git 夹具：linked worktree、submodule、非 git 目录、符号链接、大小写）+ `tests/worktree.rs`（T35：创建、基础分支、`.worktreeinclude`、`.gitignore` 行、改动、移除保留分支、重建、子 agent 分支）+ `tests/panel.rs`（Git 工具的读取：各种改动、CRLF、基础分支、状态、空仓库、分支、恶意仓库配置 THR-15、输出截断与取消）+ `tests/writes.rs`（hunk 与文件的暂存、提交与 hook、检出、删除与恢复分支、推送的拒绝与 lease、拉取冲突）+ `tests/github.rs`（Unix：假 `gh` 记录参数与 stdin，查看、创建、合并 PR 的固定参数，没有 PR 与未登录的区分） |

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
- `Git` 经注入的 `ProcessSpawner` 运行（生产是 `piarc-exec` 的进程树启动器），环境由调用方给（Core 用命令环境），另加 `GIT_TERMINAL_PROMPT=0`；超时默认 300 s，超时即杀。stdin 写完即关。每次运行都带 `-c core.longpaths=true`：Git for Windows 不开它就拒绝超过 260 字符的路径（深的 worktree、数据目录下的克隆，W3）；其他平台的 git 忽略这个键。git 目录本身仍有约 220 字符的上限（`'$GIT_DIR' too big`），`core.longpaths` 管不到。不要把 `\\?\` 路径交给 git（会变成 `//?/C:/…`），先 `strip_verbatim`。`find_program` 只认 `PATH` 中的绝对目录，排除工作区内的 git。

## Git 工具（ADR-0084、ADR-0085）

- 两种运行方式，环境只在 `env.rs` 生成：`Reader`（只读，`readonly_env`：只取系统与用户配置的位置，去掉继承的 `GIT_*`，`GIT_OPTIONAL_LOCKS=0`、`GIT_ALLOW_PROTOCOL=`、`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`；每次都带命令行覆盖 `core.fsmonitor=false`、`core.hooksPath` 指向空设备、`core.pager=cat`、`log.showSignature=false`、`gc.auto=0`，并把仓库配置里出现的每个 `filter.<名>.clean|smudge|process` 清空、`required=false`；diff 一律 `--no-ext-diff --no-textconv`）与 `Writer`（用户模式，`user_env`：ADR-0035 的准入加 `HOME`、`XDG_CONFIG_HOME`、ssh-agent、`GNUPGHOME` 与代理变量，`GIT_EDITOR=true`、`SSH_ASKPASS_REQUIRE=never`；网络操作另带 `-c protocol.ext.allow=never`）。新增查询一律经 `Reader`，不要直接调 `Git::exec`。
- 参数只经 `args.rs` 校验后放进参数数组（分支名按 Git 的引用名规则、修订版本、对象 id、相对路径、远程名），路径放在 `--` 之后，`GIT_LITERAL_PATHSPECS=1`。
- 按 hunk 的暂存、取消暂存与回滚（`index::apply_hunk`）：由当前的 index 与工作区重新生成 patch，核对 hunk 内容哈希、工作区文件 SHA-256 与 index 条目 oid，任何一项不符返回 `Stale`，再经 `git apply --cached [--reverse]`（回滚是工作区上的 `--reverse`）应用。
- `gh`（ADR-0085 第 9 条，`gh.rs`）：现在只运行 `pr view`（检查结果取自它的 `statusCheckRollup`）、`pr create`、`pr merge`，都在 ADR 的白名单里；新增子命令先核对白名单。参数一律 `--name=value` 或放在 `--` 之后（像选项的标题仍是标题的值），PR 正文经 stdin（`--body-file=-`）；`--repo` 只由 `repo_of` 从远端 URL 解析，`known_host` 只认 `github.com` 与调用方给的 `GH_HOST`。环境只在 `env.rs` 的 `gh_env` 生成（命令环境加登录环境里的 `GH_*`），程序由 `find` 从 `PATH` 中工作区以外的目录找。输出里有 "gh auth login"、"not logged into"、"HTTP 401" 等是 `GhOutcome::Auth`（`is_auth`），`pr view` 的 "no pull requests found" 是没有 PR。不加 `auth`、`config`、`extension`、`alias`、`browse`、`--web`。
- 强推只经 `remote::push_args`：`--force-with-lease=refs/heads/<分支>:<期望 oid> --force-if-includes`；受保护分支的判断不在这里（Core 的 `git::is_protected`）。
- 上限在 `diff.rs` 顶部的常量（`MAX_PATCH_FILES`、`MAX_PATCH_LINES`、`MAX_PATCH_BYTES`、`MAX_FILE_BYTES`、`MAX_FILES`）与 `exec.rs` 的超时（读 20 s、写 2 分钟、网络 10 分钟），超过时降级或取消，不放宽。

## 扩展包（`package`，T40）

- `clone_pinned(git, url, dir)`：URL 放在 `--` 之后克隆，检出为分离 HEAD 并返回提交（失败时删掉目录）；`update_pinned` 取 `origin/HEAD`（没有时 `FETCH_HEAD`）并重新检出，返回新旧提交。位置与内容由 Core 与 `piarc-config` 决定。

## 易错点

- `tests/worktree.rs` 自带一个 tokio 的最小启动器（功能 crate 不能依赖 `piarc-exec`），Windows 上同样能跑。
- 测试里的 git 用 `-c user.name/-c user.email/-c commit.gpgsign=false/-c protocol.file.allow=always` 与 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（Windows 为 `NUL`），不依赖本机配置；本地路径的 `submodule add` 需要 `protocol.file.allow=always`。

## 参考

- 架构第 10.2 节；`crates/piarc-core/src/trust.rs`。
