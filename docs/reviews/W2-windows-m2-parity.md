# W2 · Windows 11 上的 M2 验收

**结论：M2 在 Windows 11 x64 上达标。** 第 16 章的两条退出标准都满足：本机 L2 149 个场景中 145 个通过、0 个失败、4 个 macOS 专属按平台跳过，能力清单 MISSING 0；L3 对锁定的 Claude Code 2.1.318 跑 12 个权限与 hooks 场景，0 个未解释差异、0 个过期条目，`--repeat 2` 两遍一致。验收中修复了 7 个 Windows 平台缺陷，每个都先有失败的测试；W1 遗留的 UNC 项在本机补验通过。最终提交上 `npm run verify` 15/15（见文末）。

## 环境

| 项 | 值 |
|---|---|
| 平台 | `win32` x64，Windows 11 专业版 10.0.26200（与 W0、W1 同一台机器） |
| 分支与起点 | `windows/dev`，自 `e0c41ce`（`docs/architecture-design`，macOS 上 T35 进行中）起，与 T35 并行（用户安排） |
| 工具链 | Node 24.13.1，Rust 1.99.1，Git for Windows 2.56.0.windows.3（`C:\Program Files\Git`，原生程序在 `ucrt64`），PowerShell 7 与 5.1 |
| L3 的 Claude Code | 锁定的 2.1.318：`npm install --prefix tmp/l3-claude --no-save --ignore-scripts @anthropic-ai/claude-code-win32-x64@2.1.318`，平台包自带 `claude.exe`，只放在 PATH 最前，不是全局安装，不动本机的 `claude`（2.1.330） |
| 安全设置 | 未改动；UNC 用系统自带的管理共享，没有新建共享 |

证据目录 `tmp/evidence/W2/`（不入库）。

## 起点基线是红的

起点在 CI（运行 44731794641、44868949621）与本机都不绿：Windows `verify` 在 `cargo test` 与 L2 失败（检查点路径标签、子 agent 场景、Monitor 唤醒），Windows L4 的 `t28-rewind` 6 个用例失败，两个平台的 clippy 都因 T35 的 `piarc-git` 测试超过 80 行失败。这些都是 Windows 上的 M2/M3 平台问题，并入 W2 修复（F1–F5、T1–T3）；W2-A12 也要求 Windows 上 verify 通过。

## 检查表

| 检查项（验收项） | 结论 | 证据 |
|---|---|---|
| 本机 L2 与能力覆盖（A01） | 修复后通过 | 全部场景 145 通过、0 失败、4 跳过，MISSING 0（`verify-3.log` 第 14 步与之后新增 `hooks-archive-during-hook` 的全量运行） |
| Git Bash 下的 Bash 规则（A02） | 修复后通过 | L2 `perm-rule-match`、`perm-bash-compound`、`perm-read-only`、`perm-critical-delete`、`perm-bypass` 通过；`bash_cases` 新增盘符根 `C:/`、`'C:\'` 与 `$USERPROFILE` 用例（F6）；L4 `t23-permissions` 2/2；只读白名单的程序探测修复（F2） |
| PowerShell 规则（A03） | 通过 | L2 `perm-powershell-whole`、`policy-manual-powershell`、`policy-accept-edits-powershell`；Core 用例 `powershell_rules_match_whole_commands_and_always_allow_hits_again`（整条匹配、"总是允许"写入后再次命中、`PowerShell(Get-Content *)` 对 `%USERPROFILE%`、`~\`、`..\..`、`-Path:` 询问）；L4 `w1-windows-shells`（`powershell-approval.png`） |
| hooks（A04） | 通过 | `cargo test -p piarc-core --lib tool_io::hooks` 12/12：超时与回合中断后 hook 起的孙进程（PID 6416、18812）经 `tasklist` 确认结束，exit 2 阻断且理由回到模型，UserPromptSubmit 默认 30 s；L2 `hooks-*` 15/15（`hooks-windows.log`） |
| 回退与 Changes（A05） | 修复后通过 | 路径标签修复（F1）后 L2 `rewind-*`、`changes-*`（CRLF/BOM 夹具）通过，L4 `t28-rewind` 3/3；Windows 用例 `checkpoints::tests::windows`：被不共享打开的文件在预览与回退时报出文件名与 os error 32、不写入，释放后按 CRLF 字节恢复；超过 260 字符的路径与大小写不同的写法各只一条记录、按磁盘写法标注、字节恢复；记录文件的目录被换成指向外部的 junction 后不写穿 |
| 压缩（A06） | 通过 | L2 `ctx-compact-threshold`、`ctx-compact-focus`、`ctx-compact-breaker`、`ctx-compact-restore`、`ctx-usage`；L4 `t27-context`（`ring-75-warning.png`、`ring-90-context-card.png`、`after-compact-focus.png`） |
| 配置兼容层（A07） | 通过 | `cargo test -p piarc-config`（七层、家目录注入、`~/.claude.json`、rules 的 `paths:` 在 Windows 不区分大小写）；Core 默认家目录为 `std::env::home_dir()`，Windows 上即 `%USERPROFILE%`；L2 `config-merge-order`、`config-untrusted-project`、`config-rules-paths`；L4 `t24-diagnostics`；`.piarc` 做成指向 `<home>\.claude` 的 junction 时两个项目层都拒绝写入（新用例） |
| 其他 M2 界面（A08） | 通过 | L4 `t26-harness` 5/5（计划卡与评论、任务卡、提问表单与超时、下一步）、`t29-views`（三档视图）、`t29-login-models`；截图在 `tmp/evidence/W2/l4/` 与同目录 `views-*.png`、`login-*.png` |
| WebFetch、登录、文件监听（A09） | 通过 | `piarc-web` 的 SSRF 用例（`127.0.0.1`、`10.x`、`::1`、`::ffff:` 映射）与 `internal_addresses_are_refused_without_the_allowlist`；`--test sessions login` 4/4（授权码、设备码、拒绝与过期、粘贴代码，经回环端口的 mock 授权服务器）；`piarc-fs` 监听用例与 `--test state` 的设置重载（`ReadDirectoryChangesW`）；L2 `ctx-file-modified`、`webfetch-*`、`login-*`（`a09.log`） |
| L3（A10） | 修复后通过 | 见"L3"一节 |
| 平台问题与报告（A11） | 通过 | 本报告；F1–F7 均有先失败后通过的测试；登记见"登记与遗留" |
| verify（A12） | 通过 | 见文末 |

## L3

- 在 Windows 上按锁定版本运行：PiArc 侧 12 个场景 0 失败；对比 0 个未解释差异、3,707 条已说明、0 个过期条目；`--repeat 2` 一致（`l3-repeat2.log`、`l3-report.md`）。
- Windows 版 Claude Code 2.1.318 的工具集与 macOS 不同：自带 Grep、Glob（参数为 ripgrep 风格，与 PiArc 沿用 Pi 的参数不同），没有 PowerShell、KillShell、Monitor。allowlist 增加可选字段 `platforms`，这些差异用只在 Windows 适用的条目说明；Grep、Glob 的原条目限定为 macOS（edfaa51）。
- 删除过期条目 `Bash.params.run_in_background`（理由是"PiArc 还没有后台命令"，T32 已实现）。
- PowerShell 三个场景保留在排除清单：Windows 版 Claude Code 默认也没有 PowerShell 工具，`claude -p` 跑不了它们；理由已更新（I118 关闭）。
- 运行退出码为 1 的唯一原因是 `~/.claude` 有变化：变化的文件包括本会话自己的会话记录 `~/.claude/projects/…/<本会话 id>.jsonl` 与 `.claude.json` 的备份轮换，来自同时运行的交互式 Claude Code（testing.md 第 14 节已写明这种情况）；L3 的 `claude` 在隔离的 `CLAUDE_CONFIG_DIR` 与 `HOME` 下运行。没有其他 Claude Code 会话时重跑可得干净的退出码。

## R3 重点核对项

| 项 | Windows 结果 |
|---|---|
| UNC 工作区（W1-A05、I96） | 通过。本机 SMB 文件访问可用（W1 的 `net view` 1702 只是浏览接口），`PIARC_TEST_UNC_SHARE=\\localhost\C$\Users\<user>\AppData\Local\Temp` 下 `windows_paths` 5/5：经 UNC 写入 CRLF、本地读回一致、Read 与 Glob 找到。测试的 `fs/glob` 缺了 Agent Host 总会带的参数，W1 写下后从未运行，已修正（T4） |
| PowerShell 规则（P11、ADR-0047） | 通过，见 A03 |
| L3 在 Windows（I118） | 通过，见"L3" |
| Git Bash 下的只读白名单（I84） | 修复后通过：Git 2.56 把程序放进 `ucrt64`，`git status` 等永远不自动放行；一次超时的探测被永久缓存（F2）；探测本身提速（F3）。`bash_cases` 与 L2 `perm-read-only`、`perm-bash-compound` 通过 |
| hooks 的 Windows 执行 | 通过，见 A04；归档时仍在运行的 Notification hook 持有会话导致归档失败（F5） |
| 检查点与回退 | 修复后通过，见 A05（F1，junction 用例） |
| 设置写入的链接检查（P8） | 通过：junction 用例（4c9ce39） |
| 长命令与 `eval`（I102）、裁决与 AHP 往返预算（I95、I103） | 通过：2 万字符以上的命令完整执行，heredoc 保留原样，语法错误退出码 2、报 `eval: line 2: syntax error…`（d3943f2，I102 关闭）；release 构建自动裁决 1,000 次 p95 3.55 ms（预算 10 ms），`fs/read` 往返 2,000 次 p95 5.23 ms（预算 15 ms） |
| M2 的界面 | 通过：M2 的 L4 17/17（dev 形态，`l4-m2.log`）；输入法在提问表单与计划评论中的实机核对未做（W1 已核对微软拼音在 composer 中可用，日文仍未验证，I25） |

## 发现的问题与处理

| # | 问题 | 处理 |
|---|---|---|
| F1 | 检查点记录的是 `display()` 写法的路径，`Scope::label` 只认带 `\\?\` 的规范根：Windows 上回退预览、冲突与 Changes 面板全部显示绝对路径（CI 两次运行的 `cargo test`、L2 7 个场景、L4 6 个用例失败） | `label` 两种写法的根都认（cafffc1），`piarc-fs` 用例先红后绿 |
| F2 | Git Bash 程序探测：超时一次的空结果被永久缓存，只读白名单与 Accept edits 的文件命令在 Core 存活期间全部失效；Git for Windows 2.56 的原生程序在 `ucrt64`（arm64 版在 `clangarm64`），`git` 永远解析不到 | 未得到回答的探测不缓存；三个环境都接受（91f9994）；两个 Windows 用例先红后绿 |
| F3 | 探测为每个名字起一个子 shell，并为 Git 不自带的名字扫完整个 PATH：空闲 2.3 s，测试负载下超过 10 s | 只解析 Git 自带的名字，经 `hash` 读 `BASH_CMDS`，内建名才用 `type -P`：0.5 s，结果相同；超时回到 10 s（c54271b） |
| F4 | Monitor 的输出分块到达（Git Bash 先单独写出第一行）时，后一块把尚未送出的唤醒通知重建为不唤醒，会话停在空闲直到下一次输入（L2 `monitor-rate-limit` 在 Windows 失败） | 尚未送出的唤醒通知并入新行后仍唤醒，唤醒节奏提成函数（db82eae），任务单测先红后绿 |
| F5 | 回合刚结束就归档时，仍在运行的 idle Notification hook 持有会话的 I/O 状态，`Scope` 以不共享删除的方式打开着会话目录（ADR-0036），删除报共享冲突、归档失败（L3 `hooks-permission-request` 偶发） | 归档与删除会话在关闭后等 Core 放开该会话（至多 10 s）再删目录（c45ffdd）；Core 用例不等待时稳定失败；L2 `hooks-archive-during-hook` |
| F6 | `rm -rf "$USERPROFILE"` 不算关键路径删除：Git Bash 里它就是家目录，Bypass 模式或 `Bash(rm *)` 下直接执行 | `$USERPROFILE`、`${USERPROFILE}` 与 `$HOME` 一样展开（6110364），`bash_cases` 先红后绿 |
| F7 | 子 agent 的只读内置类型在 Windows 上带 `PowerShell`（设计如此），L2 的三个子 agent 场景只写了 macOS 的工具集 | 请求断言增加 `tools_windows`（82082b6），schema 与 testing.md 同步 |
| T1 | policy 夹具只关闭主会话，子会话的 `Scope` 让 Windows 删不掉测试目录（t31 4 个用例） | 夹具关闭全部会话（5ff57f6） |
| T2 | hooks 并行用例以 1.9 s 计时判断并行，测的是两个冷启动 Git Bash 的速度 | 改为两个 handler 互相等待对方启动，直接证明重叠（5ff57f6） |
| T3 | policy 夹具在测试已 panic 时清理失败再 panic，二次 panic 让整个 `piarc-core` 测试进程以 `STATUS_STACK_BUFFER_OVERRUN` 退出、掩盖其余结果 | 展开期间不再 panic（52e7d98） |
| T4 | UNC 用例的 `fs/glob` 缺 `limit`、`exclude`，授权比对正确地拒绝了它 | 按 Agent Host 的实际形状发送（08fc09e） |
| T5 | T35 的 `piarc-git` worktree 测试超过 80 行，两个平台 clippy 失败 | 带理由的 `#[expect(clippy::too_many_lines)]`（5ff57f6），T35 可按需拆分 |

## T23–T30 中等待 Windows 的验收项

无（0 项），与 R3 的统计一致。按用户在本会话的要求，W2 另外认领并关闭了看板上其他"部分完成"任务的 Windows 侧验收项（本机 Windows 11 实测，非 CI，evidence 已写明）：W1-A05、R3-A07、T32-A04、T32-A13、T33-A02、T33-A12、T33-A14、T34-A14。W1、R3、T32、T33 改为已完成；T34 仍有 A03（macOS 上的真实拼音输入法实测）。

## M2 退出标准的 Windows 证据

| 第 16 章 | Windows 证据 |
|---|---|
| 第 6 章 M2 能力全部有场景覆盖 | 能力清单 M2 46 项全部有场景，本机 L2 全部通过，MISSING 0 |
| L3 在权限与 hooks 上无未解释差异 | 12 个场景 0 未解释、0 过期，`--repeat 2` 一致 |

## 登记与遗留

| 编号 | 内容 | 建议处理 |
|---|---|---|
| I96 | UNC 工作区 | 关闭（本机管理共享补验） |
| I102 | 长命令、heredoc 与语法错误 | 关闭 |
| I118 | L3 在 Windows | 关闭（运行方式写入 testing.md 第 14 节） |
| I163 | `piarc-term/tests/pointer.rs` 只在 Unix 上编译，T34 的选区、滚动与唤醒在 Windows 上没有 Core 侧用例 | W3 |
| I164 | macOS CI（运行 44868949621）的 L2 `bg-completion-reminder` 失败，Windows 上通过 | T35（macOS）开工检查核对 |

沿用：I25（日文输入法未验证）、I49（SmartScreen 放行未观察）。

## 提交

起点 `e0c41ce`。缺陷修复：cafffc1、91f9994、db82eae、c54271b、c45ffdd、6110364；测试：5ff57f6、82082b6、52e7d98、08fc09e、717efe9、03b28cf、4c9ce39、d3943f2；L3：edfaa51；文档与计划：1f6d409、b499582、f7876f5、416db7b 与收尾提交。
