# 架构决策记录（ADR）

ADR 记录 PiArc 中影响全局、难以回退的决策：选了什么、为什么、放弃了哪些方案、什么情况下需要重新评估。

[架构设计文档](../architecture/ARCHITECTURE.md)描述系统"是什么"，ADR 解释"为什么这样"。两者冲突时以已接受的 ADR 为准，并立即修正架构文档。

## 规则

1. 改变下表任何一条决策，都要新写一份 ADR 来取代旧的。旧 ADR 状态改为"已取代"，并链接到新 ADR。不要直接改写已接受 ADR 的决策内容。
2. 新 ADR 编号顺延，文件名 `NNNN-短标题.md`。模板见 [0000-template.md](0000-template.md)。
3. 每份 ADR 必须写"重新评估的触发条件"。触发条件出现时，在对应里程碑的评审中复核。
4. 状态取值：`提议` / `已接受` / `已取代` / `已废弃`。
5. 新 ADR 只改动旧 ADR 中的个别条款时，在新 ADR 头部写"修订：ADR-XXXX 第 N 条"；旧 ADR 保持"已接受"，并在状态后注明哪一条被哪份 ADR 修订。

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-three-tier-native-architecture.md) | 原生客户端 + Rust 核心 + Pi Agent Host 三层架构 | 已取代 → 0013 |
| [0002](0002-pi-integration-via-sdk-host.md) | 基于 Pi SDK 自研 Agent Host，不 fork Pi、不以官方 RPC 为主协议 | 已接受 |
| [0003](0003-embedded-node-runtime.md) | Agent Host 运行时使用内置 Node LTS | 已取代 → 0015 |
| [0004](0004-harness-control-plane-in-core.md) | Harness 分工：策略在 Core 裁决，Agent 循环在 Pi，工具 I/O 下沉 Core | 已接受 |
| [0005](0005-claude-code-config-compatibility.md) | 兼容 Claude Code 配置生态，PiArc 自有配置独立 | 已接受 |
| [0006](0006-compliance-and-clean-room.md) | 合规红线：禁用 Claude 订阅登录、clean-room、自有品牌 | 已接受 |
| [0007](0007-macos-ui-swiftui-appkit.md) | macOS 客户端：SwiftUI 外壳 + AppKit/TextKit 2 承载高性能视图 | 已取代 → 0013 |
| [0008](0008-ffi-uniffi.md) | Swift ⇄ Rust 绑定使用 UniFFI | 已取代 → 0014 |
| [0009](0009-agent-host-protocol.md) | Core ⇄ Agent Host 使用自有版本化协议 AHP | 已接受 |
| [0010](0010-process-model.md) | 进程模型：每个工作区一个 Agent Host，子 agent 在进程内 | 已接受 |
| [0011](0011-session-storage.md) | 会话以 Pi JSONL 为事实来源，Core 维护 SQLite 索引与文件快照 | 已接受 |
| [0012](0012-distribution-developer-id.md) | 分发走 Developer ID + 公证 + Sparkle，不上 Mac App Store | 已取代 → 0016 |
| [0013](0013-electron-desktop-client.md) | 桌面客户端改用 Electron + React，macOS 与 Windows 同一代码库推进 | 已接受 |
| [0014](0014-core-binding-napi-rs.md) | Rust Core 以 NAPI-RS 原生模块加载在 Electron 主进程 | 已接受（第 4 条被 0019 修订） |
| [0015](0015-agent-host-runtime-bundled-node.md) | Agent Host 继续使用单独内置的 Node LTS，不复用 Electron 自带的 Node | 已接受（第 5 条被 0018 修订） |
| [0016](0016-packaging-signing-updates.md) | 打包、签名与更新：Electron Forge；macOS Developer ID + 公证 + 内置更新；Windows 签名安装包；不上应用商店 | 已取代 → 0018 |
| [0017](0017-terminal-libghostty-vt.md) | 内置终端：终端状态由 Core 中的 libghostty-vt 持有，渲染层可替换 | 已接受（第 3 条被 0023 修订） |
| [0018](0018-unsigned-distribution.md) | 不做平台代码签名：macOS 只做 ad-hoc 签名，Windows 不签名，更新与凭据存储随之调整 | 已接受 |
| [0019](0019-event-batches-copied-not-transferred.md) | 事件批次经主进程转发时复制，不转移 ArrayBuffer（修订 ADR-0014 第 4 条） | 已接受 |
| [0020](0020-tool-layer-composition.md) | 工具层的组成：Pi 的工具代码加 Core 的 I/O（补充 ADR-0004 第 3 条） | 已接受（第 1 条 bash 的部分被 0028 修订） |
| [0021](0021-credential-vault-and-pi-adapter.md) | 凭据保险箱的格式、并发与 Pi 凭据接口适配（补充 ADR-0018 第 5 条） | 已接受 |
| [0022](0022-transcript-rendering-libraries.md) | Transcript 渲染的库选型：@tanstack/react-virtual、marked 词法器、shiki JavaScript 引擎（补充 ADR-0013 第 5 条） | 已接受 |
| [0023](0023-terminal-frames-as-pull-replies.md) | 终端帧作为拉取请求的返回值送达渲染进程，不经事件 MessagePort（修订 ADR-0017 第 3 条） | 已接受 |
| [0024](0024-release-manifest-format.md) | 发布清单的格式、签名与校验位置（补充 ADR-0018 第 4 条） | 已接受 |
| [0025](0025-core-state-and-project-trust.md) | Core 状态的落地：数据目录、SQLite 迁移、按主 checkout 的信任与 Pi 信任接管（补充 ADR-0011、ADR-0005 第 4 条） | 已接受 |
| [0026](0026-turns-queue-and-interrupted-transcript.md) | 回合、排队与中断后的对话形态（补充 ADR-0009、ADR-0010、ADR-0011） | 已接受 |
| [0027](0027-file-tool-invariants.md) | 文件工具不变量的落点：Core 的状态表与写入，Harness Kit 的匹配与结果预算（补充 ADR-0004 第 3 条、ADR-0020） | 已接受 |
| [0028](0028-shell-command-execution.md) | Shell 命令的执行：Core 管进程、输出与语义，Bash 与 PowerShell 为 PiArc 自写工具（补充 ADR-0004 第 3 条，修订 ADR-0020 第 1 条） | 已接受 |
| [0029](0029-client-shell-foundations.md) | 客户端外壳的基础设施：令牌管线、偏好存储、快捷键、本地化、信任闸门与会话元数据（补充 ADR-0013、ADR-0025） | 已接受（第 7 条归档清理由 0030 修订） |
| [0030](0030-transcript-and-composer.md) | 会话输入、附件和 transcript 的呈现（补充 ADR-0009、ADR-0013、ADR-0026，修订 ADR-0029 第 7 条） | 已接受 |
| [0031](0031-basic-permissions.md) | M1 权限预检、审批账本与项目信任 | 已接受 |
| [0032](0032-provider-settings-and-model-selection.md) | 服务商设置、凭据更新与会话选型（补充 ADR-0006、0021、0026） | 已接受 |
| [0033](0033-session-prompt-and-memory.md) | 会话提示词快照与外部 memory 导入 | 已接受 |
| [0034](0034-bind-read-and-trust-confirmation.md) | 读取完成后登记、按已展示版本确认项目信任 | 已接受 |
| [0035](0035-command-environment.md) | 工具命令可继承的环境 | 已接受 |
| [0036](0036-bind-file-operations-to-directory-handles.md) | 文件访问与获准目录身份绑定 | 已接受 |
| [0037](0037-permission-rules-and-bash-analysis.md) | 权限规则、Bash 命令分析与模式的落地（补充 ADR-0004、0005、0031） | 已接受（阶梯第 6、7 步被 0047 修订） |
| [0038](0038-claude-code-config-compat.md) | Claude Code 配置兼容层与配置诊断的落地（补充 ADR-0005、0033） | 已接受 |
| [0039](0039-hooks-m2.md) | Hooks 的落地：M2 事件集与 command 类型（补充 ADR-0004、0005、0037） | 已接受 |
| [0040](0040-windows-automatic-permission-budget.md) | Windows 上无需用户参与的权限裁决预算 | 已接受 |
| [0041](0041-windows-ahp-round-trip-budget.md) | Windows 上小文件 fs 操作的 AHP 往返预算 | 已接受 |
| [0042](0042-plan-todo-ask-next-steps.md) | 计划模式、任务清单、提问与下一步的宿主工具（补充 ADR-0009、0031、0033、0037） | 已接受 |
| [0043](0043-reminders-compaction-usage.md) | System reminder 通道、压缩与上下文用量（补充 ADR-0009、0027、0033、0038、0039、0042） | 已接受 |
| [0044](0044-checkpoints-rewind-changes.md) | 检查点、回退、Changes 面板与会话分支的落地（补充 ADR-0009、0011、0026、0027、0030） | 已接受 |
| [0045](0045-webfetch-sign-in-model-settings.md) | WebFetch、服务商登录、每模型设置与辅助模型的落地（补充 ADR-0004、0006、0021、0032） | 已接受 |
| [0046](0046-l3-behavior-alignment.md) | L3 行为对齐基座的落地（补充 ADR-0005、0006、0039） | 已接受 |
| [0047](0047-outside-paths-before-wildcard-command-rules.md) | 越界路径的询问先于带通配的命令 allow 规则（修订 ADR-0037 阶梯第 6、7 步的顺序） | 已接受 |
