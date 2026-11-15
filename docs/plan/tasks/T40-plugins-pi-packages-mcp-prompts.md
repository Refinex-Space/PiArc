# T40 插件、Pi 包与 MCP prompts

| 项 | 内容 |
|---|---|
| 阶段 | 5 M4 安全与打磨 |
| 依赖 | T39。T39 只因 Windows 隔离评估停在设计关口、macOS 部分的验收项都已通过时，视为满足，可以开工 |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 关联需求 | FR-EX-04 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T40`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

插件对应威胁模型（第 10.1 节）中"恶意插件 / MCP server / Pi 包"一行：装上就能在 PiArc 的进程里执行代码。本任务让 PiArc 识别两类扩展包：Claude Code 插件目录（`.claude-plugin/plugin.json`）与 Pi 包（npm / git）。安装、启用与作用域由 Core 管理，可执行代码在启用前展示来源与能力并要求确认。T31、T36、T37 已为插件预留了 agents、MCP、skills 与命令的来源，本任务把它们接上。

另外补上 pi-mcp 缺的 MCP prompts：在 PiArc 的 MCP 扩展中用通用请求实现，作为斜杠命令（第 6.8 节）。本任务排在 T39 之后，是因为 T39 定稿的 Agent Host Seatbelt 配置是 Pi 扩展的第二道防线；T39 的 Windows 关口与本任务无关。

完成后：两类扩展包可以安装、启用、停用、卸载；项目未信任时项目作用域的扩展包一律不加载；Pi 包经内置 npm 以 `--ignore-scripts` 安装；MCP prompts 出现在命令面板。

## 必读

1. 架构设计：
   - 第 6.7 节"Skills、命令、插件、输出风格"
   - 第 6.8 节"MCP"（配置来源与同名取舍、prompts 缺口）
   - 第 6.3.1 节（插件 hooks 的生效范围）、第 6.4 节（子 agent 定义来源）、第 6.14 节"插件"行
   - 第 10.1 节"恶意项目配置""恶意插件 / MCP server / Pi 包""供应链"三行，第 10.2 节"项目信任"
   - 第 5.5、5.6 节（`agentDir`、内置 Node 与 npm 的布局），第 13.1 节"包管理"行
2. ADR-0004（第 4 条）、ADR-0006、ADR-0015（第 6 条）。
3. 需求规格 FR-EX-04，第 6 节"范围外"（插件市场托管服务）。
4. `docs/research/claude-official-capabilities.md` A3.1、A5.3、A8；`docs/research/pi-v1.4.0-baseline.md` 第 4.6、4.7、7.1 节。
5. T13（信任）、T31（子 agent 定义来源）、T36（MCP 扩展）、T37（skills 与命令）、T39（Agent Host 配置）交付的代码与 CLAUDE.md。
6. 实现时查阅：
   - Claude Code 插件官方文档：`plugin.json` 字段、目录结构、hooks 与 `.mcp.json` 中引用插件根目录的变量、组件命名空间；
   - Pi 锁定版本 `package-manager` 的安装目录布局、`pi` 字段、`npmCommand` 配置，以及扩展加载与 `project_trust` 事件；
   - pi-mcp 锁定版本发送通用请求与接收通知的接口；MCP 规范（pi-mcp 支持的协议版本）中的 `prompts/list`、`prompts/get`、`notifications/prompts/list_changed`。

## 范围

### 要做

- Core 插件管理：识别、安装、启用、作用域、卸载、审计。
- 插件的 commands、agents、skills、hooks、`.mcp.json` 接入既有来源；Pi 包的扩展、skills、prompt templates 接入 Agent Host。
- Pi 包的 npm 与 git 来源，npm 一律经内置 npm 且带 `--ignore-scripts`。
- 可执行代码的启用确认、再确认与信任闸门。
- mods 等不支持组件的提示。
- MCP prompts 作为斜杠命令。
- 设置窗口"skills 与插件"页的插件部分。

### 不做

- 插件市场：需求第 6 节把插件市场托管服务列为范围外，本任务只支持本地目录、git 地址、npm 包名三种来源。
- 企业对插件的管控（T47）。
- 配置诊断中插件来源的完整展示（T41）；本任务只保证诊断 API 能拿到每个组件来自哪个扩展包。
- MCP resources、sampling；elicitation（T48）。
- mods、LSP、Channels、Monitors 等组件（第 6.14 节）。

## 交付物

### 1. 识别与清单

- 插件：解析 `plugin.json`，枚举 commands、agents、skills、`hooks/hooks.json`、`.mcp.json`。含 mods 或其他组件时，插件详情与安装结果显示"不支持：<组件>"，其余组件照常加载。
- Pi 包：读 `package.json` 的 `pi` 字段，列出 extensions、skills、prompts、themes；themes 只在 Pi 的 TUI 中生效，列为"不支持"。
- 已安装记录（Core 持久化）：标识、来源类型与地址、版本（git 提交，或 npm 版本与完整性值）、作用域、启用状态、已确认的可执行项指纹。
- 插件管理放在哪个 crate，按架构第 7.1 节的职责划分决定；需要新 crate 或改变依赖方向属于变更型。

### 2. 安装、启用与作用域

- 安装位置：PiArc 数据目录。Pi 包按 Pi 锁定版本的布局放在 `pi/`（`agentDir`）下，由 Core 生成的 `pi/settings.json` 引用。
- npm：Core 经 piarc-exec 调用内置 npm，参数始终含 `--ignore-scripts`，PATH 前置内置 Node 的 `bin`，依赖同样不执行安装脚本。需要安装脚本才能工作的包，在安装结果中写明原因；不提供放开脚本的开关（放开属于放松安全基线，按变更型处理）。
- git：Core 经 piarc-git 克隆并锁定到提交；更新是显式操作，展示新旧提交。
- 作用域：用户作用域记在 PiArc 用户设置，对所有工作区生效；项目作用域声明在 `.piarc/settings.json`，只对该工作区生效。PiArc 不写 `.claude/`。
- 启用、停用、卸载后经现有的 `resources/reload` 等方法通知 Agent Host，不重启应用。
- 安装、启用、停用、卸载与确认结果写入 `audit_events`。

### 3. 组件接入

| 组件 | 接入点 | 说明 |
|---|---|---|
| commands | T37 命令列表 | 按来源分组，名称带插件命名空间 |
| agents | T31 定义来源 | 名称带插件命名空间；frontmatter 中的 `hooks`、`mcpServers` 算可执行项 |
| skills | T37 skills 发现（`resources_discover`） | 名称带插件命名空间 |
| hooks | piarc-hooks 的来源合并（第 6.3.1 节） | 只在插件启用期间生效 |
| `.mcp.json` | T36 配置来源 | 同名取舍按第 6.8 节，插件优先级最低 |
| Pi 扩展、skills、prompt templates | Agent Host 资源加载 | 扩展在 Agent Host 进程内运行 |

- 命名空间格式与引用插件根目录的变量按 Claude Code 约定实现（以官方文档为准）；插件组件不覆盖项目级或用户级的同名组件。

### 4. 启用确认与信任

- 可执行项：hooks 命令、MCP server 启动命令、Pi 扩展、子 agent frontmatter 中的 hooks 与 MCP server。
- 启用含可执行项的扩展包前，确认框列出来源（路径；git 地址与提交；npm 包名、版本与完整性值）和每个可执行项（事件与命令、server 名与命令行、扩展入口文件），并说明 Pi 扩展在 Agent Host 进程内运行、拥有与 agent 相同的权限。
- 确认在主进程弹出的原生确认框中完成（与第 10.3 节对"总是允许"规则修改的要求一致），渲染进程不能单独完成启用。不含可执行项的扩展包启用时只展示组件清单。
- 指纹：确认时记录可执行项集合的指纹；更新或配置变化引入新的可执行项时，新项在再次确认前不运行（第 10.2 节）。
- 信任：项目作用域的插件与 Pi 包在项目信任前一律不加载；Pi 的项目级扩展发现（`.pi/extensions`）也按 Core 的信任状态处理。信任对话框列出这些扩展包，展示内容与启用确认相同，信任即视为确认当时列出的项。

### 5. MCP prompts

- 在 PiArc MCP 扩展（T36）中：server 声明 prompts 能力时，用通用请求调用 `prompts/list`，每个 prompt 注册为斜杠命令，命名与参数提示按 Claude Code 的约定；收到 `notifications/prompts/list_changed` 后刷新。
- 调用时校验必填参数，`prompts/get` 返回的文本消息作为本次输入发送；不支持的内容类型给出明确提示。
- 未连接（含项目未信任）的 server 不提供命令。

### 6. 设置页

- "skills 与插件"页：已安装列表（类型、来源、作用域、启用状态、不支持组件）、安装（本地目录、git、npm）、详情、启用与停用、更新、卸载。文案中英文；Playwright 用例与亮/暗截图放在 `tmp/evidence/T40/`。

## 实现要点

- npm 安装的测试不依赖外网：用本地 tarball 或目录作为来源，夹具包带一个写标记文件的 postinstall 脚本，断言标记文件不存在；git 来源用本地裸仓库（`file://`）。
- 不读取、不打印用户的 `~/.npmrc`，registry 配置由 npm 自己读取。
- Playwright 点不到原生确认框：在主进程提供只存在于测试构建的应答钩子，用打包产物测试确认发布构建中没有它。
- 每个场景登记能力 ID，例如 `CAP-PLUGIN-HOOKS-001`、`CAP-MCP-PROMPTS-001`。

## 验收标准

- [T40-A01] 一个包含 commands、agents、skills、hooks、`.mcp.json` 的插件夹具启用后，五类组件分别生效：命令出现在命令面板并能展开，子 agent 可调用，skill 进入索引并可加载，hook 在对应事件执行，MCP server 连接并暴露工具。验证：L2 场景（每类一个，能力 ID 已登记）。
- [T40-A02] 启用含可执行项的扩展包时，主进程确认框列出来源与每个可执行项；取消后没有任何可执行项运行，确认后生效；测试应答钩子在打包产物中不存在。验证：Playwright（经测试构建的应答钩子）与截图、打包产物测试。
- [T40-A03] 扩展包更新后新增的 hook、MCP server 或 Pi 扩展在再次确认前不运行。验证：测试。
- [T40-A04] 项目未信任时，项目作用域的插件与 Pi 包不加载（无 hook 执行、无 MCP 连接、无扩展加载）；信任后加载。验证：测试。
- [T40-A05] Pi 包从 npm 来源安装时由 Core 调用内置 npm，参数含 `--ignore-scripts`，夹具包的 postinstall 脚本没有执行。验证：测试（断言进程路径与参数，标记文件不存在）。
- [T40-A06] Pi 包从 git 来源安装并确认后，`pi` 字段声明的扩展、skills、prompt templates 加载生效，themes 列为不支持。验证：L2 场景。
- [T40-A07] 含 mods 的插件显示"不支持"提示，其余组件照常加载。验证：测试与截图。
- [T40-A08] 声明 prompts 能力的 MCP server 的每个 prompt 出现在斜杠命令列表的 MCP 分组中，带参数调用后 `prompts/get` 的结果作为输入发送；server 发出 prompt 列表变化通知后命令列表更新。验证：L2 场景（mock MCP server）与 mock provider 请求断言。
- [T40-A09] 用户作用域的扩展包在所有工作区可用，项目作用域的只在声明它的工作区可用；停用与卸载后组件立即消失，不需要重启应用。验证：测试。
- [T40-A10] 安装、启用、停用、卸载与确认结果写入审计表。验证：测试。
- [T40-A11] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 创建或更新插件管理所在 crate 与 `agent-host` 的 CLAUDE.md：安装布局、可执行项指纹规则、命名空间、易错点。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：内置 npm 调用（`--ignore-scripts`）、原生确认框的测试应答钩子。
- 更新架构第 6.7 节：插件的安装位置、确认与再确认流程。
