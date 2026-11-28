# 0004. Harness 分工：策略在 Core 裁决，Agent 循环在 Pi，工具 I/O 下沉 Core

- 状态：已接受（第 3 条的实现方式由 ADR-0020 补充）
- 日期：2026-11-14
- 相关：架构文档第 6、7 章

## 背景

Claude Code 级 Harness 的能力分属两类：

- **随 agent 循环运行的**：子 agent、plan 模式、todo、上下文注入、压缩、工具定义与提示词。Pi 的扩展 API 都覆盖得到（`tool_call` 可阻断/改写、`before_agent_start` 可改 prompt 段、`turn_end`/`agent_before_settle` 可要求续跑、`registerTool` 支持 `deferred` 暴露）。
- **涉及安全、持久化或操作系统的**：权限规则存储与裁决、hooks（运行任意 shell 命令）、文件快照、沙箱、PTY、凭据、企业策略、审计。这些需要跨会话、跨进程的一致性，且 Windows 要复用。

Pi 的内置工具（read/write/edit/bash/grep/find/ls）都通过可替换的 `*Operations` 接口执行 I/O（`core/tools/bash.ts:75` 等），官方 `ssh.ts` 示例就把这些操作转发到了远端。

Pi 扩展和 Pi 本身没有隔离（同进程、同权限），所以权限扩展不能作为唯一的安全边界。

## 决策

1. **控制面在 Core。** 权限规则、模式、hooks 配置与执行、项目信任、沙箱策略、企业策略都由 Core 持有和裁决。Agent Host 中的 Harness Kit 只负责在正确时机向 Core 发起询问，并执行 Core 的决定。
2. **agent 循环在 Pi。** 模型请求、流式解析、工具调度、上下文组装、压缩留在 Agent Host，不在 Rust 中重写。
3. **工具 I/O 下沉 Core。** Harness Kit 用 Pi 的 `create*Tool(..., { operations })` 重建内置工具，把文件读写和命令执行委托给 Core（经 AHP）。Core 因此能在每次写入前做快照、在沙箱中执行命令、用 PTY 管理后台进程、统一审计。
4. **双重防线。** Agent Host 进程本身在 Seatbelt 配置下运行，写入只限于工作区、PiArc 数据目录与会话临时目录。即便某个第三方 Pi 扩展绕过了 Harness Kit，也受进程级限制（具体配置在 M4 确定，见架构文档第 10.3 节）。
5. **失败即拒绝。** Core 不可达、超时、返回无法解析时，Harness Kit 一律按拒绝处理（与 Pi `tool_call` handler 抛异常即阻断的语义一致）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 全部 Harness 写在 Pi 扩展里 | 实现快，官方示例可直接改 | 规则存储、审计、沙箱、PTY 在 Node 里实现，Windows 侧的原生能力难接；安全边界落在无隔离的扩展上 | 否决 |
| 在 Rust 中重写 agent 循环 | 控制力最强 | 等于放弃 Pi 的核心价值 | 否决 |

## 后果

- 正面：权限、hooks、快照的行为在所有会话和平台上一致；Core 可以脱离模型做确定性测试。
- 负面与代价：每次工具调用多一次 AHP 往返（本机 stdio，预算 p95 < 5 ms，见架构文档第 11 章）；`*Operations` 接口随 Pi 版本变化时要同步。
- 需要配套做的事：把 Pi 内置工具的委托实现做成独立模块，并为每个工具写契约测试。

## 重新评估的触发条件

- AHP 往返延迟成为可感知瓶颈（工具调用 p95 > 20 ms）；
- Pi 移除或大幅修改 `*Operations` 接口。
