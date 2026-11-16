# piarc-git

git 的状态、diff、worktree、分支。T13 起只有一项：目录所属仓库的主 checkout（`checkout::resolve`），它是项目信任的键。不存信任、不判定信任。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-git` | 单元测试 + `tests/checkout.rs`（真实 git 夹具：linked worktree、submodule、非 git 目录、符号链接、大小写） |

## 主 checkout 解析规则

从目录向上找第一个 `.git`：

| `.git` | 情况 | 信任键 |
|---|---|---|
| 目录 | 普通仓库 | 仓库根 |
| 文件，`gitdir` 下有 `commondir` | linked worktree | `commondir` 指向的主仓库 git 目录的父目录（git 目录不叫 `.git` 时，如 bare 或分离的 git 目录，用 git 目录本身） |
| 文件，没有 `commondir` | submodule 或分离 git 目录的仓库 | 含 `.git` 文件的目录（独立项目） |
| 一直找不到 | 非 git 目录 | 目录自身 |

- 路径一律经 `canonical`：解析符号链接、取磁盘上的大小写、去掉 Windows `\\?\` 前缀（`strip_verbatim`）。比较与存储都用规范路径。
- 只读 `.git` 文件与 `commondir`，不启动 git 进程。

## 易错点

- 测试里的 git 用 `-c user.name/-c user.email/-c commit.gpgsign=false/-c protocol.file.allow=always` 与 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（Windows 为 `NUL`），不依赖本机配置；本地路径的 `submodule add` 需要 `protocol.file.allow=always`。

## 参考

- 架构第 10.2 节；`crates/piarc-core/src/trust.rs`。
