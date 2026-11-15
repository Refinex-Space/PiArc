# T09 Transcript 渲染与 composer 原型（S1）

| 项 | 内容 |
|---|---|
| 阶段 | 1 M0 技术验证 |
| 依赖 | T03 |
| 执行平台 | macOS（CI 同时覆盖 Windows；Windows 实机结论在 W0） |
| 推荐配置 | Opus 5.5，effort xhigh，新会话 |
| 规模 | 大 |
| 关联验证项 | S1（渲染进程 transcript 与 composer） |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T09`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

transcript 是用户停留时间最长的界面。换成 Web 之后，原生方案的富文本风险没有了，剩下的问题是：长会话流式输出时会不会卡，滚动跟随是否可靠，模型输出能否被安全地渲染，输入法下 composer 会不会误发送。

S1 的通过标准（架构第 16 章）：第 11 章的流式与滚动预算；跨块选择复制；中文、日文输入法在两个平台正常。本任务用录制或合成的事件流驱动渲染进程（不接 Core），做出 transcript 渲染管线与 composer 的原型，实测选定虚拟列表、Markdown 解析、代码高亮三类库，写成 ADR。

原型由 T19 接入真实事件流，所以按正式实现的标准写。Windows 上的输入法与性能结论在 W0。

## 必读

1. 架构设计：
   - 第 8.2 节"信息架构"中 composer 与 transcript 行类型
   - 第 8.3 节"状态与数据流"、第 8.4 节"Transcript 渲染管线"
   - 第 8.5 节"交互规范"中输入法守卫与外部链接两行
   - 第 10.3 节中模型输出的渲染规则
   - 第 11 章中流式渲染、万条 item 滚动、会话切换、渲染进程内存四行
2. ADR-0013（第 5 条渲染进程的基础选型）、ADR-0006。
3. `docs/research/ui-reference-notes.md` 第 2、3、7 节。
4. `docs/research/electron-stack.md` 第 9 节"前端库"。
5. T03 交付的安全基线、`window.piarc` 白名单、L4 基座与 CLAUDE.md。
6. 实现时查阅：候选库锁定版本的文档（@tanstack/react-virtual 的 `anchorTo`、`followOnAppend`；react-virtuoso 的 `followOutput`；shiki 的 token 级 API 与正则引擎选项；ProseMirror 的 view、keymap、node spec）；Chrome DevTools Protocol 的 `Input.imeSetComposition`；open-claude-ui 中滚动跟随与输入法守卫的逻辑（MIT，只看交互逻辑，复用时注明出处）。

## 范围

### 要做

- transcript：虚拟列表、Worker 增量 Markdown、Worker 代码高亮、安全渲染、流式节奏、滚动跟随与"回到底部"、跨块选择与"复制本条消息"。
- composer：ProseMirror、@ 胶囊占位、输入法守卫、Enter / Mod+Enter / Esc 语义。
- 事件流夹具与性能测量。
- 库选型 ADR（补充型）与 S1 报告（macOS 部分）。

### 不做

- 接入 Core 的真实事件流、P0 行类型的完整卡片（T19）；正式 store（T18），本任务用一个最小的本地 store 驱动原型。
- 审批卡（T20）、三档视图（T29）、@ 文件模糊匹配与 `/` 命令面板（T19、T37）、公式与 Mermaid（P1）。

## 交付物

### 1. 事件流夹具

- 用 `packages/protocol` 中的 item 事件类型（`item/started`、`item/agentMessage/delta`、`item/completed` 等）描述事件流，T19 可以直接换成真实数据。
- 合成器按给定 token/s 回放，内容覆盖段落、列表、表格、多语言与超长代码块、未闭合的围栏与强调、XSS 载荷；能生成 1 万条 item 的历史。

### 2. transcript

| 部分 | 要求 |
|---|---|
| 虚拟列表 | 只挂载可见区及上下约一屏的行；行高按 `itemId + 宽度` 缓存；底部锚定。@tanstack/react-virtual（`anchorTo: 'end'`）与 react-virtuoso 在同一组测量下对比后选定 |
| Markdown | Worker 中增量解析，只重解析最后一个未完成的块；流式中自动闭合未完成的标记；输出块与 span 的中间结构，由 React 组件渲染。解析库实测后选定，要求能输出语法树而非 HTML 字符串，支持 GFM 表格与任务列表 |
| 代码高亮 | Worker 中运行，候选 shiki；用 token 级 API 产出结构化 token，不用 HTML 字符串输出；流式代码块先显示纯文本，块完成后替换为高亮 |
| 安全渲染 | 不使用 `innerHTML`、`dangerouslySetInnerHTML`（ESLint 规则禁止）；原始 HTML 当文本显示；链接点击走 T03 的外链确认；远程图片不加载，显示为链接 |
| 流式节奏 | `requestAnimationFrame` 中平滑输出字符，不明显落后于实际进度；参数集中定义 |
| 滚动跟随 | 在底部时内容增长无动画贴底；滚轮、触控板、拖动滚动条、键盘向上滚动即解除；回到距底阈值内恢复；离底超过阈值显示"回到底部"。阈值集中定义，以第 8.4 节的参考取值为起点调校 |
| 选择与复制 | 跨块连续选择后复制得到正确文本；每条消息提供"复制本条消息"（Markdown 与纯文本两种） |

- 剪贴板写入需要在 T03 的权限放行清单中加入对应权限，写明理由并加测试。

### 3. composer

- ProseMirror 多行输入；@ 胶囊节点（本任务用固定的假候选列表），胶囊的存储数据、显示形态、发送时拼接的文本三者分开（第 8.2 节）。
- 键盘语义：空闲时 Enter 发送、Shift+Enter 换行；运行中 Enter 为 steer、Mod+Enter 为排队、Esc 停止。"运行中"由夹具状态模拟。
- 输入法守卫：所有键盘处理先检查 `event.isComposing` 与 `keyCode === 229`；`compositionstart` 到 `compositionend` 之间，Enter、Esc、`/`、`@` 都不触发业务。

### 4. 性能测量

在 Playwright 驱动的 Electron 中测量生产渲染产物，记录机型与系统版本，两个虚拟列表候选跑同一组测量：

- 100 token/s 流式 60 秒：超过 50 ms 的长任务数量，帧时间分位数；
- 1 万条 item 自动滚动：帧率；
- 1,000 条 item 冷加载：从数据就绪到首屏可见行渲染完成的耗时；
- 打开 1,000 条 item 时的渲染进程内存（`app.getAppMetrics()`），对照第 11 章。

### 5. ADR 与报告

- 库选型 ADR：编号取 `docs/adr/` 最大编号加一，状态"已接受"，标题后注明"补充"；覆盖虚拟列表、Markdown 解析、代码高亮，含测量数据与放弃方案的理由。同步更新架构第 8.4 节：选定的库，以及调校后的滚动阈值与流式参数。
- `docs/spikes/S01-transcript-composer.md`：测量数据、调校参数、XSS 测试结果、输入法核对结果、结论。macOS 已验证：自动化测试与测量、macOS 拼音与日文输入法的真实核对；待 W0：微软拼音、Windows 上的性能测量。更新 `docs/spikes/README.md`。

## 实现要点

- shiki 默认的正则引擎依赖 WebAssembly，需要 CSP 放开 `wasm-unsafe-eval`。不放宽 CSP：用 shiki 的 JavaScript 正则引擎或其他不需要放宽 CSP 的方案。确实需要放宽时属于变更型（放松安全基线），写 ADR 提议。
- 流式期间只有最后一个 item 重新渲染：store 按 item 订阅，已完成的行做记忆化，用渲染计数验证。
- Playwright 没有直接的输入法接口：用 CDP 的 `Input.imeSetComposition` 驱动合成过程，再派发 `keyCode 229` 的按键。真实输入法的核对由智能体按清单尽量执行；必须由人操作的项写进报告的"待用户核对"清单，用户核对后补记结果，R1 汇总时检查。
- 测量受机器影响：报告写明机型；与第 11 章基准机型（M1 Pro / 16 GB）不同时注明。

## 验收标准

- [T09-A01] 两个虚拟列表候选在同一组流式与滚动测量下都有数据，选定结果与理由写入库选型 ADR，架构第 8.4 节已同步。验证：测量输出、ADR 与架构文档的改动。
- [T09-A02] 100 token/s 流式 60 秒期间，渲染进程主线程没有超过 50 ms 的长任务，帧时间 p99 ≤ 16 ms。验证：测量输出（含机型）。
- [T09-A03] 1 万条 item 自动滚动期间帧率 ≥ 60 fps。验证：测量输出。
- [T09-A04] 1,000 条 item 冷加载 ≤ 300 ms。验证：测量输出。
- [T09-A05] 流式中只重解析最后一个未完成的块；未闭合的代码围栏与强调被自动闭合；流结束后的渲染结果与一次性完整解析的结果一致。验证：单元测试。
- [T09-A06] 代码高亮在 Worker 中完成，流式代码块先显示纯文本、完成后显示高亮；渲染进程代码中引入 `innerHTML` 或 `dangerouslySetInnerHTML` 被 ESLint 拦截。验证：组件测试与临时违规时的 lint 输出。
- [T09-A07] XSS 载荷集（`<script>`、内联事件属性、`javascript:` 链接、带脚本的 SVG、`<iframe>`、`<style>`）全部以文本呈现，测试中的哨兵变量未被改动，CSP 与 T03 相同。验证：Playwright 测试与 CSP 对比。
- [T09-A08] 输入法合成期间按 Enter、Esc、`/`、`@` 不触发发送、停止、命令或提及；合成结束后行为恢复。验证：基于 CDP 合成的测试。
- [T09-A09] composer 的 Enter、Shift+Enter、Mod+Enter、Esc 在空闲与运行中两种状态下符合交付物 3；@ 胶囊的存储数据、显示形态与发送文本三者分开。验证：组件测试与 Playwright 测试。
- [T09-A10] 跨段落与代码块的选择复制得到正确文本；"复制本条消息"的 Markdown 与纯文本两种格式正确。验证：Playwright 测试（读取剪贴板）。
- [T09-A11] 在底部时内容增长自动贴底；向上滚动超过解除阈值后不再跟随；回到恢复阈值内重新跟随；离底超过按钮阈值时显示"回到底部"。验证：Playwright 测试。
- [T09-A12] S1 报告（macOS 部分）含测量数据、调校参数、真实输入法核对结果（或"待用户核对"清单）与待 W0 的项，`docs/spikes/README.md` 已更新。验证：文件内容。
- [T09-A13] `npm run verify` 通过。验证：命令输出。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 更新 `apps/desktop/CLAUDE.md`：transcript 与 composer 的目录、Worker 消息格式、安全渲染规则、滚动与流式常量的位置、性能测量命令。
- 在 `coding-standards.md` 的"通用能力复用"表中登记：输入法守卫、滚动跟随判定、增量 Markdown 解析、XSS 载荷集。
- 参考了 open-claude-ui 的交互逻辑时，在代码注释与提交说明中注明出处（仓库、路径、版本）。
