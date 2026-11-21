# 0058. 插件、Pi 包与 MCP prompts 的落地（补充）

- 状态：已接受，补充 ADR-0004、ADR-0015、ADR-0025、ADR-0039、ADR-0048、ADR-0053、ADR-0054
- 日期：2026-11-21
- 相关：架构第 5.5、5.6、6.3.1、6.4、6.7、6.8、6.14、10.1、10.2 节；T40；FR-EX-04；登记事项 I154、I155、I158、I160

## 背景

架构第 6.7 节定了方向：PiArc 识别 Claude Code 插件目录与 Pi 包，安装、启用、作用域由 Core 管理，可执行代码在启用前展示来源与权限并要求确认；第 6.8 节把 MCP prompts 列为可在扩展层用通用请求补上的缺口。T40 要定下基线没写到的细节：安装记录放哪里、作用域写在哪个文件、"确认"按什么粒度记录、组件以什么名字进入既有来源、Pi 包的扩展怎样交给 Agent Host、MCP prompts 怎样成为斜杠命令。

调研结论（2026-11-21 核对锁定版本与官方文档）：

- Claude Code 插件：`.claude-plugin/plugin.json` 可省略（名称取目录名），`name` 不含空格、`@`、`:`、路径分隔符；`commands`、`agents` 的清单路径替换默认目录，`skills` 追加，`hooks`、`mcpServers` 与默认文件合并；`.mcp.json` 的 `mcpServers` 外层可省略。组件命名空间：命令与 skill 为 `/<plugin>:<名称>`，子 agent 为 `<plugin>:<名称>`，MCP server 在 `/mcp` 中为 `plugin:<plugin>:<server>`、工具名为 `mcp__plugin_<plugin>_<server>__<tool>`。`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 在 hook 命令、MCP 配置与 skill、命令、子 agent 正文中替换。mods（JS hooks module）在 `hooks/hooks.json` 的 `modules` 中声明。
- Pi 1.5.2 的包管理器把 npm 包装到 `<agentDir>/npm/`（一个 npm 前缀），git 包克隆到 `<agentDir>/git/<host>/<path>`；`package.json` 的 `pi` 字段列出 extensions、skills、prompts、themes，没有该字段时按约定目录。它的 `resolve()` 遇到 `settings.json` 的 `packages` 中尚未安装的来源会直接安装：npm 不带 `--ignore-scripts`，git 克隆后在包目录运行 `npm install`。`--prefix` 经过符号链接时 npm 写出错误的锁文件路径（macOS 的 `/var` → `/private/var`）。
- pi-mcp 锁定版本有 `McpClient.request(method, params)` 与 `onNotification(method, listener)`，没有 prompts 专用 API；MCP 2025-11-25 的 `prompts/list`（分页）、`prompts/get`（`messages` 的 `content` 为 text、image、audio、resource 等）与 `notifications/prompts/list_changed`。Claude Code 把 prompt 列为 `/servername:promptname (MCP)`，`/mcp__servername__promptname` 也可运行，参数按空白切分。

## 决策

### 记录、声明与作用域

1. **安装记录在 `core.sqlite`。** 新表 `packages`（schema v10）：id、类别、来源类别与地址、安装目录、git 提交、版本、npm 完整性值、已确认可执行项名称的集合、时间。读写在 `piarc-store`，编排在 `piarc-core::plugins`，包目录的解析在 `piarc-config::plugins`；不新增 crate，依赖方向不变。
2. **声明在设置的 `plugins` 键。** `plugins` 是 id → 布尔的对象：用户级 `settings.json` 声明的对所有工作区生效（用户作用域），`.piarc/settings.json`（及 `.local`）声明的只对该工作区生效（项目作用域），项目层的值盖过用户层的（项目可以为自己关掉某个用户级包）。项目文件的 `/plugins` 列入可执行指针：项目未受信任时不进合并，项目作用域的包一律不加载。Claude Code 的 `enabledPlugins`（`name@marketplace`）与 `extraKnownMarketplaces` 改为忽略：插件市场在范围外（需求第 6 节），PiArc 的插件只来自本地目录、git 地址、npm 包名。
3. **安装即关闭。** 安装只取文件并写记录，在所选作用域的文件里写 `plugins.<id> = false`；开启是单独的一步（见第 7 条）。设置每次加载时，`TrustService::permission_settings` 用这份设置与记录算出生效的包（`piarc_config::plugins::active`）并挂在 `Settings` 上，hooks、MCP、skills、命令、子 agent 定义与 `plugins/extensions` 都从同一次加载取，不各自读记录。

### 取文件

4. **npm 一律经内置 npm 且不运行安装脚本。** Core 以内置 `node` 运行同目录发行包里的 `npm-cli.js`（进程是内置 node，参数含 `--ignore-scripts`、`--no-audit`、`--no-fund`、`--legacy-peer-deps`），`PATH` 最前是内置 Node 的目录，环境取命令环境（ADR-0035），npm 自己读用户的 `.npmrc`，PiArc 不读不打印。布局沿用 Pi：`<数据目录>/pi/npm/` 是一个前缀，`--prefix` 传真实路径。版本与完整性值取锁文件里该包的条目；包声明了 `preinstall`、`install`、`postinstall`、`prepare` 时，安装结果写明它们没有运行、相关部分可能不工作。不提供放开脚本的开关：那是放宽安全基线，按变更型处理。
5. **git 克隆并锁定提交。** 经 `piarc-git::package` 克隆到 `<数据目录>/pi/git/<host>/<path>`（URL 在 `--` 之后，地址的每一段只留字母、数字与 `.-_`），检出为分离 HEAD 并记下提交；包有 `dependencies` 时在包目录用内置 npm 以 `install --omit=dev` 加第 4 条的参数安装依赖。更新是显式操作：取远端默认分支的提交并重新检出，结果写明新旧提交。
6. **本地目录原地使用。** 记录目录的规范路径，不复制；卸载不删除它。

### 确认与信任

7. **逐项确认。** 可执行项是：hook（事件、matcher 与运行的命令或地址，与信任清单同一种名字）、MCP server（池中的名字加程序或地址与参数）、Pi 扩展（相对包目录的入口文件）、子 agent 定义里的 hooks 与内联 server（前缀子 agent 类型名）。记录里存已确认项的名字集合；生效的包只运行已确认的项，命令、skill、子 agent 定义本身是指令，开启即加载。更新或文件变化带来的新项在再次确认前不运行，旧项照常运行。
8. **确认只在主进程的原生对话框里完成。** 开启含可执行项的包、允许新增项时，主进程从 Core 取包的清单，原生确认框列出来源（路径；git 地址与提交；npm 版本与完整性值）与每个可执行项，含 Pi 扩展时说明它在 Agent Host 进程内运行、拥有与 agent 相同的权限；只把确认框列出的项交给 Core（`packageSetEnabled` 的 `confirm`、`packageConfirm`）。不含可执行项的包同样弹框，只列组件。渲染进程不能单独完成开启。Playwright 点不到原生对话框：主进程的 `NativeConfirm` 接受开发构建测试钩子的 `answerConfirm`；测试钩子只在加载开发版 Core 时安装，发布构建没有，`check-app-layout.mjs --flavor release` 核对发布版 Core 没有测试导出。
9. **项目作用域与信任。** 信任视图在 `.piarc/` 文件开启的包旁列出它的全部可执行项（来源 `plugin:<id>`），用户信任即把列出的项记为已确认；包的新增项不让整个项目回到未信任（`StoreLookup` 与视图的 `newItems` 都不计入 `plugin:` 项），只在包上显示等待确认。在受信任的项目里经设置页以原生确认开启项目作用域的包时，`.piarc/settings.json` 新增的那一项经 `confirm_items` 并入信任快照（与 T20 的原生确认同一做法）。

### 组件接入

10. **命名空间与优先级。** 插件的命令为 `<plugin>:<相对路径以 : 连接>`，skill 与子 agent 为 `<plugin>:<名称>`，MCP server 为 `plugin_<plugin>_<server>`（工具名因此是 Claude Code 的 `mcp__plugin_<plugin>_<server>__<tool>`；插件名不得含 `__`）。它们排在所有项目与用户来源之后，同名时不覆盖项目级或用户级组件。Pi 包的 skill 与 prompt template 不加命名空间（Pi 的做法），同样排在最后。来源分别是 `ResourceSource::Plugin`、`AgentSource::Plugin`、`McpScope::Plugin`，并带 `plugin` 字段（诊断 API 由此知道组件来自哪个包）。
11. **替换插件变量。** `${CLAUDE_PLUGIN_ROOT}` 换成包目录，`${CLAUDE_PLUGIN_DATA}` 换成 `<数据目录>/plugins/data/<id>`（`[A-Za-z0-9_-]` 以外的字符换成 `-`），作用于 hooks、MCP 定义的全部字符串值与命令、skill、子 agent 正文。它们不作为环境变量导出给 hook 进程。
12. **插件 skill 与命令的 `allowed-tools`、hooks 不生效。** 它们不在第 7 条的可执行项里；`tool_io::skills` 把 `plugin` 来源当作未覆盖，调用时只给出未生效的警告。
13. **Pi 扩展经 AHP 交给 Agent Host，不写进 `pi/settings.json`。** 任务提示要求由 Core 生成的 `pi/settings.json` 引用 Pi 包；我们没有这样做：Pi 的 `resolve()` 会为缺失的来源运行带安装脚本的 npm（违反第 4 条），`pi/settings.json` 对所有工作区生效、表达不了项目作用域与逐项确认。改为 AHP `plugins/extensions`（Agent Host → Core，能力 `plugins`）：Core 答出当前目录生效的包里已确认的扩展入口文件，Agent Host 作为 `additionalExtensionPaths` 交给 Pi 的资源加载器（按普通文件加载，Pi 不解析、不安装包）。包的 skill 与 prompt template 由 Core 的发现读（ADR-0054），themes 只在 Pi 的 TUI 生效，列为不支持。`resources/reload` 时 Agent Host 重新取：扩展有变化的空闲会话立即在同一 id 下重开，运行中的在回合结束后重开；同时让 MCP 池重新读配置。子 agent 的会话不加载包的扩展。
14. **不支持的组件。** 插件的 mods（`hooks.json` 的 `modules`）、`lspServers`/`.lsp.json`、monitors、channels、themes、output styles、workflows、`bin/`、`userConfig`、`dependencies`、内联的命令映射与 `.mcpb`/URL 形式的 MCP 包列为"不支持：<组件>"，其余组件照常加载；输出风格的 `force-for-plugin` 因此仍为忽略。

### MCP prompts

15. **在 Agent Host 的连接池里用通用请求实现。** server 声明 `prompts` 能力时，连接后用 `prompts/list` 分页取全（至多 20 页），收到 `notifications/prompts/list_changed` 后重取并发状态变化（客户端随之重新取命令列表）。只有已连接的工作区 server 提供命令，项目未受信任的 server 不连接，因此也没有命令。
16. **命令名与展开。** 命令名 `mcp__<server>__<prompt>`（server 名中 `[A-Za-z0-9_-]` 以外的字符换成 `_`，prompt 名照原样），类别 `mcpPrompt`、来源 `mcp`，参数提示由声明的参数生成。`resources/listCommands` 把它们接在 Core 的命令之后（同名不覆盖）。用户输入以 `/mcp__` 开头时由 Agent Host 在准备输入前展开：参数按空白切分、依声明顺序对应，多出的词并入最后一个参数，缺少必填参数时请求失败；`prompts/get` 返回的各条消息的文本以空行连接作为本次输入，`command` 记下用户输入的原文（转录照常显示原文）；出现 text 以外的内容时请求失败并说明 PiArc 不发送该类型。Core 不认识这些名字，原样交给 Agent Host（T37 的 `expand_command` 返回 `None`）。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Pi 包写进 Core 生成的 `pi/settings.json`，由 Pi 解析与加载 | 与 Pi 的 CLI 布局完全一致 | Pi 会为缺失来源运行带脚本的 npm；全局生效，做不到项目作用域与逐项确认 | 否决（第 13 条） |
| 安装记录写成数据目录里的 JSON 文件，由 `piarc-config` 直接读 | 配置层不用 Core 注入记录 | 确认集合是安全决定，应与信任决定一样在 Core 的数据库里；多一份需要原子写的文件 | 否决 |
| 以包为单位确认（任何变化都要求整包再确认） | 实现简单 | 一次更新让全部 hook 与 server 停掉，用户难以看出改了什么 | 否决：逐项确认，新项单列 |
| 包的新增项让项目回到未信任 | 与第 10.2 节"新增项再确认"的字面一致 | 一个包的更新会停掉整个项目的可执行配置 | 否决：包的项由包自己的确认管 |
| MCP prompts 由 Core 展开 | 与命令文件同一入口 | prompt 来自连接，连接只在 Agent Host 的池里 | 否决 |

## 后果

- 新增：`piarc-config::plugins`（读包、可执行项、`active`、`declarations`/`listed`）、`piarc-store` 的 `packages` 表、`piarc-git::package`、`piarc-core::plugins`（`PluginManager`、`plugins/extensions`）与 NAPI 的 `packages*`；协议 `plugins` 模块与各组件的 `plugin` 字段；Agent Host 的 `runtime/plugin-extensions.ts`、`mcp/prompts.ts`；设置页"Skills 与插件"的插件部分与主进程 `plugins-ipc.ts`。
- `TrustService::permission_settings` 在有声明时多读一次 `packages` 表并读包目录；没有声明的工作区不受影响。
- Claude Code 插件的 mods、LSP、monitors、channels、themes、output styles、workflows、`bin/`、`userConfig` 与插件市场仍不支持；插件 skill 与命令的 `allowed-tools`、hooks 不生效；hook 进程拿不到 `CLAUDE_PLUGIN_ROOT` 环境变量（只在命令文本中替换）。登记为后续事项。
