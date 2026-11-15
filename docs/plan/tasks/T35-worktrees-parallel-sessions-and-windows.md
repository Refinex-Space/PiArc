# T35 Worktree、并行会话、多窗口、全文搜索与后台常驻

| 项 | 内容 |
|---|---|
| 阶段 | 4 M3 多会话与生态 |
| 依赖 | T34 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-WS-04、FR-WS-05、FR-WS-06、FR-SY-02、FR-SY-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T35`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

需求场景 S3"同时推进三件事"：三个会话并行，可以各自在独立 worktree 中运行，侧栏显示状态，需要审批时收到通知，应用不卡。本任务补齐这个场景需要的能力：会话与子 agent 的 worktree、会话全文搜索、多窗口、关闭窗口后后台常驻（菜单栏 / 托盘）、`piarc://` 与从 Finder / 资源管理器打开文件夹。

M3 的退出标准"3 个并行会话 + 子 agent 场景满足第 11 章内存预算"在本任务中首次测量，测量脚本要能一条命令复现，R4 会在 M3 全部完成后复测。

## 必读

1. 架构设计：
   - 第 6.12 节"Worktree 与并行会话"、第 3.3 节"进程模型"
   - 第 8.1 节（主进程职责）、第 8.2 节（新建会话选择 worktree、环境栏）、第 8.8 节"平台集成"
   - 第 9.1 节（`.piarc/worktrees/`、`.gitignore` 提示）、第 9.2 节（`sessions.worktree`、`session_fts`）、第 9.3 节"保留与清理"
   - 第 10.2 节"项目信任"、第 11 章"性能预算"
2. ADR-0010（同一工作区的 worktree 会话共用一个 Agent Host）、ADR-0018（Windows 打开文件夹的实现方式随安装包形式确定）。
3. `docs/research/claude-official-capabilities.md` 第 A7.4 节。
4. T13（存储、信任按主 checkout 解析）、T14（会话编排）、T18（外壳与新建会话、单实例锁）、T31（子 agent 的 `isolation` 字段）交付的代码与 CLAUDE.md。
5. 实现时查阅：
   - `git worktree` 的命令行为（或 piarc-git 已选定的库）；
   - SQLite FTS5 的分词器文档，尤其中文检索；
   - Electron 锁定版本的 `Tray`、`app.setAsDefaultProtocolClient`、`open-url`、`open-file`、`second-instance`、`app.dock`。

## 范围

### 要做

- 会话独立 worktree：创建、基础分支、`.worktreeinclude`、归档处理与到期清理。
- 子 agent `isolation: worktree`。
- 会话全文搜索（FTS5，从 JSONL 增量同步）与搜索界面。
- 多窗口（共用 Core，审批一致）。
- 关闭窗口后后台运行；菜单栏 / 托盘图标与计数。
- `piarc://` URL scheme；从 Finder / 资源管理器打开文件夹。
- 3 个并行会话 + 子 agent 的内存测量。

### 不做

- WorktreeCreate / WorktreeRemove hooks（T48）。
- Windows 上托盘、URL scheme、资源管理器右键菜单的实机验证（W3）；本任务在 Windows 上以 CI 测试覆盖。

## 交付物

### 1. 会话 worktree

- 新建会话时可选"在独立 worktree 中运行"：Core 在 `.piarc/worktrees/<name>/` 创建 worktree 与新分支（命名规则写进 piarc-git 的 CLAUDE.md），可选基础分支；按 `.worktreeinclude`（gitignore 语法）把被忽略的文件（如 `.env`）复制进去。会话 cwd 为 worktree，环境栏显示 worktree 名与分支。
- 首次在仓库中创建 worktree 时，提示把 `.piarc/worktrees/` 加入 `.gitignore`（第 9.1 节）。
- worktree 会话属于主仓库所在工作区，共用同一个 Agent Host（ADR-0010 决策 1）。
- 项目信任与"总是允许"规则按主 checkout 解析：`.piarc/settings.local.json` 不在 worktree 中，规则从主 checkout 读取与写入。
- 归档：worktree 有未提交改动时先询问（保留 worktree 并归档 / 丢弃改动并删除 / 取消）。归档会话的 worktree 默认 30 天后清理（时钟可注入）；清理时仍有未提交改动则先询问。清理只删除 worktree 目录，保留分支。

### 2. 子 agent worktree 隔离

- 定义了 `isolation: worktree` 的子 agent 在临时 worktree（`.piarc/worktrees/agent-<id>/`）中运行，基础提交为父会话工作树的当前 HEAD（补充型决策，写进 CLAUDE.md）。
- 结束时无改动则自动清理；有改动则保留，结果中给出路径与分支。
- 移除 T31 中"该字段尚未支持"的报错。子 agent 在临时 worktree 中的编辑照常进入快照。

### 3. 全文搜索

- `session_fts`（FTS5）索引用户消息与助手正文，复用 T13 的 JSONL 增量同步管线；"重建索引"同时重建 FTS。
- 中文必须可检索：评估 FTS5 的 `trigram` 分词器（含查询少于 3 个字符时的处理）或其他方案，选型理由写进报告；测试覆盖中文、英文与混排。
- 侧栏搜索框：结果带高亮片段，按会话分组；点击后打开会话并定位到对应条目。

### 4. 多窗口

- "在新窗口中打开会话"；所有窗口共用主进程中的同一个 Core。
- 审批一致：同一审批在多个窗口同时显示时，只接受第一个有效答复，其他窗口的卡片随之消失（T20 的审批账本）。
- 窗口位置与大小写入主进程的窗口状态文件（第 7.3 节），重启后恢复。

### 5. 后台常驻

- 关闭最后一个窗口后应用不退出，会话与后台任务继续运行（第 3.3 节）。
- macOS 菜单栏图标、Windows 托盘图标：显示运行中与等待审批的计数；菜单含打开窗口、等待审批的会话列表、退出。图标从 `design/brand/mark.svg` 导出（macOS 为黑色加透明的 template 图，Windows 为 `.ico`），导出文件放回 `design/brand/`。
- 退出时若有运行中的会话或后台任务，先确认（后台任务会被终止，T32）。

### 6. `piarc://` 与打开文件夹

- 注册 `piarc://`（应用标识沿用 T12 起落实的 D2）；链接与命令行参数经单实例锁交给已运行的实例。
- 路由只做定位：打开文件夹作为工作区、打开指定会话；T29 的 OAuth 回调保持原有处理。链接参数不接受任何会自动执行的内容（例如自动发送的提示词）；打开未信任的文件夹时照常显示信任对话框。
- macOS：从 Finder 拖入窗口、拖到 Dock 图标（`open-file`）。Windows：资源管理器右键菜单"用 PiArc 打开"，实现方式随 Velopack 安装形式确定（ADR-0018），用 CI 单元测试覆盖注册与参数解析。

### 7. 内存测量

- 测量脚本放在 `scripts/perf/`，一条命令完成：1 个窗口，同一工作区 3 个并行会话（至少 1 个在独立 worktree），每个会话用 mock provider 持续流式输出并执行工具调用，其中一个会话派出 1 个子 agent；稳态后采样各进程 RSS（主进程含 Core、渲染进程、GPU 等辅助进程经 `app.getAppMetrics()`，Agent Host 单独计）。
- 对照第 11 章当前值（R1 可能已收紧）：Agent Host ≤ 单会话预算 + 每增加一个活动会话的增量 ×（活动会话数 − 1），子 agent 计为一个活动会话，按目前的 150 MB 与 40 MB 即 ≤ 270 MB；应用其余进程合计 ≤ 450 MB。
- 结果写入 `docs/perf/M3-memory.md`：环境、数据、结论。超出预算时先定位原因（Pi 模块级缓存、渲染进程、事件批次等），本任务范围内能修的修，修不了的登记并在报告中标为 R4 的风险；预算只能收紧，不能放宽。

## 实现要点

- worktree 操作全部经 piarc-git，路径比较前规范化（第 15.3 节），测试夹具含空格与中文路径。
- 清理与归档涉及删除用户数据：删除前再次检查未提交改动，删除失败时保留现场并报告，不重试强删。
- 菜单栏计数来自 Core 的实体快照，不在主进程中另算一份。

## 验收标准

- [T35-A01] 新建会话可选独立 worktree：在 `.piarc/worktrees/<name>/` 创建 worktree 与分支，可选基础分支，`.worktreeinclude` 列出的被忽略文件被复制。验证：L2 场景。
- [T35-A02] worktree 会话使用主 checkout 的项目信任与"总是允许"规则，新写入的规则落在主 checkout。验证：测试。
- [T35-A03] 归档有未提交改动的 worktree 会话时先询问；到期清理删除 worktree 目录并保留分支，清理时有未提交改动先询问。验证：场景测试（时钟可注入）与 Playwright。
- [T35-A04] `isolation: worktree` 的子 agent 在临时 worktree 中运行，无改动时结束后自动清理，有改动时保留并在结果中给出路径与分支。验证：L2 场景。
- [T35-A05] 全文搜索能查到中文、英文与混排的用户消息和助手正文；JSONL 新增内容增量进入索引；重建索引后结果一致。验证：测试。
- [T35-A06] 点击搜索结果打开对应会话并定位到该条目。验证：Playwright。
- [T35-A07] 两个窗口同时显示同一审批时只有先到的答复生效，另一个窗口的卡片随之消失。验证：Playwright（截图存 `tmp/evidence/T35/`）。
- [T35-A08] 关闭最后一个窗口后会话继续运行，菜单栏图标显示运行中与等待审批的计数；有运行中的会话时退出需确认。验证：Playwright 与截图。
- [T35-A09] `piarc://` 链接与从 Finder 拖入的文件夹在已运行实例中打开对应工作区或会话；链接参数不触发任何自动执行，未信任的文件夹照常显示信任对话框。验证：测试。
- [T35-A10] Windows 托盘、`piarc://` 注册与资源管理器右键菜单的注册与参数解析有单元测试并在 Windows CI 上通过。验证：Windows CI 输出。
- [T35-A11] 同一工作区 3 个并行会话（至少 1 个在独立 worktree）加 1 个子 agent 的稳态内存满足第 11 章预算（Agent Host 按活动会话数计算的上限、应用其余进程合计上限）。验证：测量脚本输出与 `docs/perf/M3-memory.md`。
- [T35-A12] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `crates/piarc-git` 与 `crates/piarc-store` 的 CLAUDE.md：worktree 命名与清理规则、FTS 分词选型；更新 `apps/desktop/src/main/` 的 CLAUDE.md：托盘、URL 路由、窗口状态。
- 在根 `CLAUDE.md` 的命令一节加入内存测量命令。
- 在 `PLAN.md`"登记事项"中为 W3 列出 Windows 核对项：worktree 路径（长路径、大小写）、托盘、右键菜单、3 会话内存。
