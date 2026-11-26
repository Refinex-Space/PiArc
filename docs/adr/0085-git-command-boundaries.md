# 0085. Git 命令的执行边界（补充）

- 状态：已接受，补充 ADR-0025、ADR-0035、ADR-0062、ADR-0064
- 日期：2026-11-25
- 相关：ADR-0084、0086；架构第 7.6、10.1 节；[设计增补](../architecture/addenda/git-panel.md)；`tests/security/threats.yaml`

## 背景

Git 工具要在面板打开、窗口获得焦点、回合结束时自动读取仓库（status、diff、log、refs），并在用户点击时执行暂存、提交、检出、拉取、推送。仓库目录里的 `.git/config`（随 zip 下载的仓库会自带）可以让 git 运行任意程序：`core.fsmonitor`、`core.hooksPath`、`filter.*.clean|smudge|process`、`diff.external`、textconv、`log.showSignature` 配合 `gpg.program`、`core.pager`、`core.sshCommand`、`credential.helper` 等。现有只读查询 `tool_io/git_status.rs` 用隔离全局与系统配置的方式防御，但这样会丢掉 `core.autocrlf` 等影响 diff 结果的设置（Git for Windows 把它写在系统配置里）。

推送与拉取需要用户的 ssh-agent 与 credential helper；ADR-0035 的命令环境准入列表不含 `SSH_AUTH_SOCK`，它约束的是模型发起的命令。强推、回滚、强制检出、删除分支会丢失数据；渲染进程被注入时可能伪造这些调用（ADR-0062 的 THR-11）。

## 决策

1. **只读模式。** 面板自动发起的查询读取用户的系统与全局配置，在命令行以 `-c` 覆盖会执行程序的键：`core.fsmonitor=false`、`core.hooksPath=<空设备>`、`log.showSignature=false`、`core.pager=cat`、`diff.external=`、`gc.auto=0`、`maintenance.auto=false`；先在同一配置集下枚举全部 `filter.*.(clean|smudge|process)`，逐个清空并设 `required=false`；diff 加 `--no-ext-diff --no-textconv`，log 加 `--no-show-signature`。环境为 ADR-0035 准入字段加 `HOME`、`XDG_CONFIG_HOME`，清掉继承的 `GIT_*`，设 `GIT_OPTIONAL_LOCKS=0`、`GIT_NO_LAZY_FETCH=1`、`GIT_ALLOW_PROTOCOL=`、`GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`、`GIT_LITERAL_PATHSPECS=1`、`LC_ALL=C`。不设 `safe.directory=*`。
2. **写操作只在受信任项目。** 用户点击的写操作先经 `piarc_core::trust` 判断（失败即不信任），未受信任返回 `untrusted`，界面引导用户经 ADR-0064 的原生确认信任项目。受信任之后，写操作使用用户完整配置，hooks 与 filter 照常运行，效果等同于用户在终端执行 git；这一点登记为接受的风险。
3. **用户模式的环境。** ADR-0035 准入字段加 `HOME`、`XDG_CONFIG_HOME`、`SSH_AUTH_SOCK`、`SSH_AGENT_PID`、`GNUPGHOME` 与代理变量（`http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`，大小写两种），清掉继承的 `GIT_*`，设 `GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS_REQUIRE=never`、`GIT_EDITOR=true`、`GIT_SEQUENCE_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`、`GIT_LITERAL_PATHSPECS=1`；网络命令加 `-c protocol.ext.allow=never`。PiArc 保险箱里的凭据与服务商密钥不进入该环境；git 走用户自己的代理配置，不经 Agent Host 代理或沙箱代理。git 程序与命令共用 `git_runner` 的解析（登录 shell 的 PATH，排除工作区内的 git）。凭据失败时不提示输入，界面提供"在终端中运行"。
4. **参数由 Core 约束。** 远端只接受 `git remote` 列出的名字；分支名经 `git check-ref-format --branch` 且不以 `-` 开头；修订参数前加 `--end-of-options`；路径必须是文件根内的相对路径，放在 `--` 之后；hunk 操作只收标识（路径、段、序号、内容哈希、工作区 SHA-256、index oid），patch 由 Core 在仓库写锁内用原始字节重新生成，任何一项不符返回 `stale`。
5. **并发。** 写操作按仓库 common dir 在 Core 内串行，只读操作不加锁。会改动工作区的操作（检出、拉取、回滚、继续、中止、跳过）要求同一文件根下所有会话空闲，否则返回 `sessionBusy`；完成后从这些会话的文件状态表移除受影响路径。遇到 `index.lock` 不删除，退避两次后返回可重试的 `busy`。
6. **危险操作的确认与审计。** 全部写操作要求窗口近期有真实输入（弹出窗口经 `bindToolInput` 计入）。Git 回滚、强制检出、强推、删除未完全合并的分支、把"始终强制推送"打开，先由 Core 的 `describe` 给出事实（分支、远端、旧 / 新 oid、文件数与路径），主进程以原生确认展示，确认后携带 Core 给出的期望值执行，Core 再核对。强推一律 `--force-with-lease=<ref>:<期望 oid> --force-if-includes`；受保护分支（用户级 `git.protectedBranches`，默认 `main`、`master`，`*` 通配）只在 Core 判断，强推在调用 git 之前拒绝。推送、强推、回滚、强制检出、删除分支各写一行 `kind: "git"` 审计，不含文件内容与提交信息正文。
7. **回滚可撤销。** Git 回滚前在路径锁内把工作区字节存入 `piarc_checkpoint::ObjectStore`，写 `checkpoint_files` 的新操作 `gitRestore`，index 条目（mode、oid、暂存状态）存为同批次的 `gitRestoreIndex` 记录；两种操作不进回退计划与本会话视图，随会话检查点的保留期清理。撤销经 `piarc_fs::replace` 核对回滚后的哈希写回，再恢复 index 条目。
8. **输出脱敏。** git 的 stderr、进度文本与远端 URL 先按结构去掉 userinfo 与 ANSI 转义，再经 `piarc_telemetry::redact`（补充 `scheme://<token>@host` 与 PEM 私钥规则）交给页面与日志；日志不写 stderr 原文。
9. **`gh`（G5 适用）。** 程序从工作区以外的 PATH 解析；环境设 `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`；子命令白名单为 `pr view/create/list/merge/checks` 与 `repo view`，禁止 `auth`、`config`、`extension`、`alias`、`browse` 与 `--web`；`--repo` 由 Core 从远端解析且主机在已登录主机内；`GH_TOKEN`、`GITHUB_TOKEN`、`GH_HOST`、`GH_CONFIG_DIR` 只在用户登录环境本来就有时传给 gh，不进 git 与模型命令。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只读查询沿用 `git_status.rs`，隔离全局与系统配置 | 执行面最小 | 丢失 `autocrlf`、`ignorecase` 等，Windows 上 diff 全错、hunk patch 对不上 | 否决；用命令行覆盖 + 枚举 filter + 恶意配置测试 |
| 写操作一律中和 hooks 与 filter | 不执行仓库程序 | 提交绕过团队的 pre-commit；关掉 clean filter 会把 LFS 文件的真实内容提交进去 | 否决；改为信任闸门 |
| 用户模式使用完整登录环境 | 最接近终端 | 登录环境里的服务商密钥与令牌进入 git 与 hook 进程 | 否决 |
| PiArc 实现 askpass（原生输入框） | 带口令的密钥、host key 确认能在面板里完成 | 需要回调通道、凭据存储与 Windows 适配 | 推迟；先用"在终端中运行" |
| 危险操作只在渲染进程确认 | 交互轻 | 注入的页面可绕过 | 否决 |

## 后果

- 正面：自动刷新不会执行仓库自带的程序；页面被注入时无法外传仓库或静默丢弃数据；diff 与用户在终端看到的一致。
- 负面与代价：未受信任项目里 Git 工具只读；每次 Git 回滚多一次原生确认；带口令且未加入 agent 的 SSH 密钥要在终端完成推送。
- 需要配套做的事：架构 10.1 节新增威胁行"恶意仓库的 Git 配置"（THR-15），THR-02、THR-04、THR-11 增加对策，`tests/security/threats.yaml` 映射新测试；`piarc-telemetry::redact` 补规则；`credential_leaks` 扩展到 git 进程。

## 重新评估的触发条件

- git 新增会执行程序的配置键或改变命令行覆盖的优先级（升级最低 git 版本时复核第 1 条的清单）；
- 实现 PiArc 自己的 askpass；
- Windows 实机发现 GCM 或 Git for Windows 的配置与上述环境冲突；
- 用户需要在未受信任项目里提交。
