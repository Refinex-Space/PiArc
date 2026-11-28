# 首次运行：欢迎屏与连接模型（设计增补）

- 日期：2026-11-28
- 状态：已确认（2026-11-28 用户确认按本增补实施）
- 决策：ADR-0110（首次运行引导与完成标记，补充型，实施时写成"已接受"）
- 输入：用户 2026-11-28 的需求与三张参考截图（OpenClaudeDesktop `next-4.16336.0` 的欢迎页、Choose your agent、Connect a model）。参考只定层级、节奏与交互，代码、文案、组件不复制（ADR-0006），视觉可高度参考（ADR-0073）。
- 评审：产品、架构、测试、安全四路评审，裁决表在附录。

## 1. 背景与目标

今天新装 PiArc 后直接落在新会话页：没有空状态，模型按钮显示"自动模型"，唯一的入口是模型菜单最底下的"配置服务商"，用户要到发送时才看到报错。

目标：

1. 新用户第一次打开，一分钟内从"什么都没配"到"有一个连通的模型"，然后落到新会话页开始工作。
2. 老用户升级、已经配过服务商的人不被打扰。
3. 现在不想配的人可以跳过，之后在新会话页和设置里都能找回同一个入口。

## 2. 范围

### 2.1 做

- 全窗口的引导层，两步：**欢迎** → **连接模型**。
- 连接模型支持三条路：内置服务商填 API key、账号登录（OAuth）、自定义或本地端点。
- 用户级偏好 `onboarding.completed` 与"是否自动出现"的推导规则。
- 两个再次进入的入口：设置"模型与服务商"页的"快速设置…"；新会话页在已打开项目且没有任何可用模型时，模型按钮变成"连接模型"。
- `Mascot` 加 `size` 与 `testId` 参数，欢迎屏放大显示。

### 2.2 不做

- **"选择 agent"一步**：PiArc 只有 Pi 一个 harness。
- 单独的"选择项目"一步：新会话页已经有"接下来，在 [项目] 做点什么？"。
- 在引导里选默认模型：PiArc 没有默认模型偏好，保存后 Pi 自动选该服务商的默认或第一个可用模型。
- 欢迎屏上的语言切换：界面语言默认跟随系统，设置里可改。
- 吉祥物的新动作（庆祝、走位）：沿用现有编排。
- Core、AHP、NAPI 的接口改动，包括"测试未保存的配置"。也不新增 IPC。
- 新的测试专用环境变量。

## 3. 需求与验收标准

### 3.1 何时出现

| 编号 | 标准 |
|---|---|
| F1 | 自动出现的条件是同时满足三点：`completed` 为假；第一份工作区快照里没有工作区；不是由 `piarc://` 或拖入文件夹启动的。`completed` 由 `preferencesFrom` 推导，满足任一项即为真：settings.json 里 `onboarding.completed === true`、`modelProviders.providers` 非空、`modelProviders.accounts` 非空。 |
| F2 | 第一份工作区快照到达之前不画引导层，也不画新会话页的主体，避免先闪一下新会话页再盖上引导层。 |
| F3 | 反例，以下情况都不出现：已有服务商或登录账号；已有工作区；只经 `pi/models.json` 配置了模型（L4 的 mock）且已有标记。 |
| F4 | 偏好会广播到所有窗口：在任一窗口完成或跳过，所有窗口的引导层都关闭。 |
| F5 | 写标记时被托管设置拒绝（`reason: managed`），本次运行照样关闭引导层，不报错。 |

### 3.2 欢迎

| 编号 | 标准 |
|---|---|
| W1 | 居中显示：放大的方块吉祥物（编排与新会话页相同，强调色），字标"PiArc"，一句副标题。底部是主按钮"开始设置"和文字按钮"稍后设置"。 |
| W2 | "稍后设置"写入 `onboarding.completed = true`，进入新会话页。 |
| W3 | 欢迎一步按 Esc 不关闭，避免误触。 |
| W4 | 窗口高度 ≤ 560 px 时隐藏吉祥物，按钮不被挤出窗口。减少动态效果时吉祥物静止，切换步骤不做动画。 |
| W5 | 引导层顶部留出窗口拖动区。macOS 的红绿灯区域不被内容遮住。 |

### 3.3 连接模型

| 编号 | 标准 |
|---|---|
| C1 | 一张填充卡片，左边是快速设置宫格，右边是所选项的表单。宽度不足 880 px 时改成上下排列。 |
| C2 | 宫格按服务商家族各占一格，每格是服务商标记、名称和一行说明。<br>中文界面的顺序：DeepSeek、智谱 GLM、Kimi、通义千问、MiniMax、小米 MiMo、OpenAI、Anthropic、Gemini、OpenRouter。<br>英文界面把后四家排在前面。<br>之后依次是"账号登录""更多服务商…""自定义端点""本地模型"。<br>家族里有哪些变体按运行时的 `builtinProviders` 过滤，目录里一个都没有的家族不显示。默认选中第一格。 |
| C3 | 有多个变体的家族（地区或套餐），右侧用"地区与套餐"选择器（`ChoiceButton`，不用原生 select）列出变体名，例如"中国大陆 · Coding Plan"。中文界面默认选国内变体，英文界面默认选国际变体。 |
| C4 | 内置服务商的表单：API key（password 类型，关闭自动填充）和"获取密钥 ↗"。链接来自渲染进程里写死的官方 https 地址表，点击后经主进程原生确认才打开。 |
| C5 | 家族里有能登录的服务商时，key 输入框下方显示次要入口"或使用账号登录"，复用 `useSignInDialog`。"账号登录"一格列出全部 `loginProviders`（如 ChatGPT/Codex、GitHub Copilot），不含 Claude.ai 订阅。 |
| C6 | 自定义端点与本地模型的表单：协议、base URL、key（本地端点可以不填）、模型。"获取模型"只在点击时请求，结果显示为可点选的芯片。"高级"里可以改服务商 id。校验沿用 `provider-form.ts` 的 `fieldErrors`，与 Core 规则一致。 |
| C7 | "更多服务商…"打开现有的 `ServiceChooser`：选中内置服务商会把它填进右侧表单，选中登录项会开始登录。 |
| C8 | key 按所选项分开保存。切换宫格、切换变体、修改 base URL 或协议时清空已输入的 key。key 不写进 sessionStorage、hash、偏好、toast、live region 或错误详情。保存成功、离开这一步、关闭引导层时也清空。 |
| C9 | 右下角是"返回"和主按钮"测试并继续"，下面一句说明，按平台区分"这台 Mac"和"这台电脑"：密钥加密保存在本机，只发给所选的服务商；测试会发一个很小的请求。自定义端点的说明写出实际主机名。 |
| C10 | 宫格里已连接的服务商标"已连接"。对已连接的内置服务商输入新 key 时，主按钮变为"替换密钥并测试"。 |

### 3.4 测试并继续

| 编号 | 标准 |
|---|---|
| T1 | 点击后先 `saveProvider`，再 `testProvider`。进行中按钮显示 loading 并禁用，连点只保存一次。表单字段在测试期间禁用。 |
| T2 | 测试成功：卡片内显示一行"已连接"，包括服务商标记、实际用到的模型和延迟，主按钮变成"开始使用"。点击后写入完成标记，进入新会话页。 |
| T3 | 测试失败：显示一行失败原因（经 `reason()`，纯文本，不识别链接）。提供两个操作："修改后重试"会聚焦 key 输入框；"跳过测试"会写入完成标记并进入新会话页。凭据保留在连接列表里，与设置页的行为一致。 |
| T4 | 失败带 `network: true` 时多一个"代理设置"。它打开设置的代理页，引导层隐藏但不卸载；关闭设置后引导层回来，状态和焦点都还在。登录对话框里的"代理设置"同样处理。 |
| T5 | 登录成功等同于测试成功（T2），显示登录到的账号。拒绝、过期或取消时留在这一步。 |
| T6 | 测试最长等 Core 的 45 s 超时，期间可以点"返回"放弃等待，晚到的结果不再改变界面。 |

### 3.5 再次进入与键盘

| 编号 | 标准 |
|---|---|
| R1 | 设置"模型与服务商"页的"连接"一节标题行有"快速设置…"。点击后先关闭设置，再直接打开到"连接模型"一步；这时"返回"会关闭引导层。 |
| R2 | 新会话页已打开项目、模型目录为空时，模型按钮显示"连接模型"，点击打开同一个连接步骤。模型菜单里原有的"配置服务商"不变。 |
| R3 | 引导层打开时，下层工作台是 `inert` 的，全局快捷键不生效（同设置层的拦截），Tab 被限制在引导层内。从设置或新会话页打开的引导层，关闭后焦点回到打开它的控件。连接一步按 Esc 等同于"返回"。 |
| R4 | 引导层不新增 IPC。写凭据只经现有的 `saveProvider`、`startLogin`；外链只经 `openExternal`。 |

### 3.6 视觉与无障碍

| 编号 | 标准 |
|---|---|
| V1 | 颜色、字号、间距只来自令牌。新增 `font.size.hero`（30 px）给字标和步骤标题用，不引入衬线或打包字体。主色仍是强调色。 |
| V2 | 符合视觉规范：卡片用填充，不描边，不卡片套卡片。宫格项是填充按钮，选中时是强调色的环（box-shadow）。浅色与深色下都看得出悬停和选中，相邻格之间留 2 px 以上。不用原生 `title`、select 或滚动条样式。 |
| V3 | 步骤切换是形态变化（`motion.slow`、`curve-out`），进入与退出对称，减少动态效果时立即完成。 |
| V4 | 两个状态登记到 `e2e/a11y/states.ts`（`window:onboarding-welcome`、`window:onboarding-connect`，不要和已有的 `window:welcome` 混淆），接入 `t43-a11y` 旅程。亮暗两种主题下 axe 通过，中英文截图没有溢出。 |
| V5 | 步骤标题在进入时获得焦点。宫格是 `radiogroup`，可以用方向键选择。 |

## 4. 设计

### 4.1 偏好（照 ADR-0109 `power` 的做法）

- `crates/piarc-config/src/schema.rs`：`PIARC_SETTINGS` 新增 `onboarding`，其中 `completed: Bool`。
- `crates/piarc-core/src/client_settings.rs`：`CLIENT_KEYS` 加 `onboarding`，补一行文档注释。
- `apps/desktop/src/shared/preferences.ts`：
  - `Preferences.onboarding: { completed: boolean }`，默认值为 `false`。
  - 在 `preferencesFrom` 里按 F1 推导，只读 `modelProviders.providers` 与 `accounts` 的长度。
  - `PreferenceChange` 新增 `{ key: 'onboarding.completed'; value: true }`。`pointerOf` 只接受 `true`。
- 不做数据迁移：老用户由推导规则和"有工作区"的条件挡住。

### 4.2 渲染进程 `apps/desktop/src/renderer/onboarding/`

| 文件 | 内容 |
|---|---|
| `Onboarding.tsx` | 引导层：步骤状态、入口来源（自动、设置、新会话页）、关闭与焦点归还、拖动区 |
| `Welcome.tsx` | 欢迎一步 |
| `ConnectModel.tsx` | 卡片、宫格、右侧表单的切换、测试与结果行 |
| `families.ts` | 纯数据与函数：家族表（id、标记、变体及其地区/套餐标签、默认变体规则、可登录的 id）、按界面语言排序、按 `builtinProviders` 过滤、"已连接"的判定 |
| `key-links.ts` | 官方"获取密钥"地址表。只收 https，实施时逐条核对官网 |
| `visibility.ts` | 纯函数 `shouldShow(prefs, workspacesSnapshot, launchPending)` |
| `onboarding.css` | 样式，只读令牌 |

复用：

- `settings/provider-form.ts`：`makeForm`、`fieldErrors`、`configOf`、`parseTestResult`、`parseSettings`
- `settings/ModelDiscovery.tsx`
- `settings/ServiceChooser.tsx`
- `settings/SignInSection.tsx` 的 `useSignInDialog`
- `shell/icons.tsx` 的 `ProviderMark`
- `app/Button.tsx`、`ChoiceButton`

挂载：

- `shell/Shell.tsx` 在 `SettingsLayer` 旁边挂 `Onboarding`，`position: fixed`。
- 引导层打开时加进 `.shell` 的 `inert` 表达式，并加进 `run()` 的快捷键拦截。
- 设置打开时引导层隐藏，不卸载。

打开入口：

- Shell 持有 `ui.openOnboarding(step, from)`。
- 设置页的"快速设置…"经它打开。它先关设置，所以不需要新的 IPC。
- 新会话页的"连接模型"也经它打开。

吉祥物：

- `shell/Mascot.tsx` 加可选参数 `size`（每格像素数，默认 6）、`testId`（默认 `home-mascot`）、`className`。
- 欢迎屏用 `size={12}`、`testId="onboarding-mascot"`。

### 4.3 令牌与文案

- `design/tokens/scale.json` 加 `font.size.hero: 30px`，然后运行 `npm run gen:tokens`。
- i18n 两份目录新增 `onboarding.*` 键。说明文案按平台区分。变体名写进 i18n，家族名用品牌原文。

### 4.4 数据与安全边界

- 密钥只存在于 `ConnectModel` 内的表单 state。存放方式是"所选项 → key"，换了所选项即丢弃。
- 宫格与变体只来自写死的家族表与 Core 给的 `builtinProviders` 的交集。链接只来自 `key-links.ts`。
- 自定义端点的 https 与回环规则已经由 Core 强制（`crates/piarc-core/src/providers.rs:357-366`、`:398-405`），前端校验只为了提示。
- 回显：实施时先确认 `testProvider` 失败时的消息会不会带出 key（`agent-host/src/providers/checks.ts:88-98`）。会带出的话，先写失败测试，再在 Agent Host 里把本次 key 替换掉。

### 4.5 兼容

- 老用户：有服务商、账号或工作区时不出现。
- ADR-0083 之前只经 OAuth 登录、又没有任何工作区的极少数人会看到一次欢迎屏，点"稍后设置"即可。这一点写进 ADR 作为保留风险。
- 托管设置：不支持锁定这个键（F5）。

## 5. 测试计划

### 5.1 Rust

- `cargo test -p piarc-config`：schema 接受 `onboarding.completed`，拒绝非布尔值。
- `cargo test -p piarc-core --lib client_settings`：`onboarding` 可写，托管锁定时拒绝。

### 5.2 Vitest

| 编号 | 文件 | 覆盖 |
|---|---|---|
| U1 | `onboarding/families.test.ts` | 每个家族的变体齐全；`openai-codex` 只出现在登录里；目录里缺的 id 被隐藏；两种语言的排序与默认变体 |
| U2 | `onboarding/visibility.test.ts` | 真值表：标记、providers、accounts、工作区、启动目标；只经 `pi/models.json` 配置时不改变结果 |
| U3 | `shared/preferences.test.ts` | 推导规则；`pointerOf` 只接受 `onboarding.completed = true` |
| U4 | `onboarding/ConnectModel.test.tsx`（happy-dom） | 连点只调一次 `saveProvider`；切换所选项清空 key；`testProvider` 挂起时可以返回，晚到的结果被忽略；失败行是纯文本 |
| U5 | `onboarding/key-links.test.ts` | 地址全部是 https；每个家族都有链接（本地与自定义没有） |

### 5.3 L4（`PIARC_EVIDENCE_TASK=onboarding npx playwright test -c apps/desktop/playwright.config.ts onboarding --project dev`）

先修夹具：

- 基础 `userDataDir` 夹具预写 `{"onboarding":{"completed":true}}`，并导出 `L4_USER_SETTINGS`。
- 整份覆盖 settings.json 的 spec 改成合并：t39、t43、t45-xss、t45-diagnostics、t46、git-panel、t36、t38、agent-host-kill 等，实施时用 grep 找全。
- 引导自己的 spec 删掉这个标记。

用例：

| 编号 | 用例 |
|---|---|
| E1 | 全新目录自动出现欢迎屏。截图亮暗、中英文。页面上只有一个 `home-mascot` 类的吉祥物 testid |
| E2 | "稍后设置"后进入新会话页；重启后不出现 |
| E3 | 自定义端点指向 `piarc-mock-provider`：获取模型、选中、测试并继续、显示已连接、开始使用；新会话页能完成一个回合 |
| E4 | mock 返回 401：失败行显示答复原文；修改后重试成功 |
| E5 | 端点指向关闭的端口：失败，带"代理设置"；进入设置后返回，状态还在 |
| E6 | 登录：`PIARC_TEST_OAUTH_PROVIDER` 加 `piarc-mock-auth`，分别 approve、deny、expire |
| E7 | 内置服务商（如 DeepSeek）只测到保存为止：输入假 key 保存后进入测试中的状态，连接列表有 deepseek。不等真实请求的结果 |
| E8 | 设置里点"快速设置…"打开到连接一步，"返回"关闭；新会话页打开项目、没有模型时，"连接模型"打开同一步 |
| E9 | 只用键盘：Tab 被困在引导层内，全局快捷键（如 Mod+,）不生效，Esc 行为符合 W3 与 R3，焦点归还正确 |
| E10 | 减少动态效果；窗口高度 ≤ 560 px |
| E11 | 两个窗口：在一个窗口完成后，另一个也关闭 |
| E12 | "获取密钥 ↗"弹出原生确认（`stubMessageBox`），取消则不打开 |
| E13 | t43 旅程加入两个新状态；t45-egress 不受影响 |

### 5.4 回归

- 全量 `npm run verify`。
- `npm run bench:t18`：冷启动到侧栏就绪仍在 1.0 s 内，因为 F2 会等工作区快照。

## 6. 风险与待确认

| 风险 | 处理 |
|---|---|
| 内置服务商在 L4 里无法走完测试（Core 拒绝给内置服务商设 `baseUrl`） | 只测到保存为止；成功路径用自定义端点和 mock OAuth 覆盖。不新增测试接口 |
| 先保存后测试，会留下未通过测试的凭据 | 与设置页一致，界面明确提示。连接列表可以测试或删除 |
| 只经 OAuth 登录、又没有工作区的老用户会看到一次欢迎屏 | 写进 ADR 作为保留风险 |
| F2 等待工作区快照可能拖慢首屏 | 用 `bench:t18` 核对；超出预算就改成快照前先画新会话页骨架 |
| 家族表与 Pi 目录漂移（升级 Pi 后 id 变化） | 运行时取交集，缺失的自动隐藏；U1 用当前目录做快照，升级 Pi 时会提醒 |
| 官方"获取密钥"地址变化 | 地址表集中在一个文件，实施时逐条核对 |

## 7. 实施步骤

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 偏好：schema、`CLIENT_KEYS`、`preferences.ts` 的类型、推导与 `pointerOf` | `cargo test -p piarc-config`、`cargo test -p piarc-core --lib client_settings`、`npx vitest run apps/desktop/src/shared/preferences.test.ts` |
| 2 | L4 夹具预写标记，整份覆盖 settings.json 的 spec 改成合并 | `npm run typecheck`；抽跑 `smoke`、`t39-`、`t45-xss`（dev 形态） |
| 3 | 令牌 `font.size.hero`；`Mascot` 的参数 | `npm run gen:tokens`、`node scripts/ci/check-design-tokens.mjs`、`npx playwright test home-mascot --project dev` |
| 4 | `families.ts`、`key-links.ts`、`visibility.ts` 及其单测 | `npx vitest run apps/desktop/src/renderer/onboarding` |
| 5 | `Onboarding`、`Welcome`、`ConnectModel` 组件及样式、i18n；Shell 的挂载、`inert` 与快捷键拦截 | U4；`node scripts/ci/check-i18n.mjs`；`npm run lint` |
| 6 | 再次进入：设置页的"快速设置…"、新会话页的"连接模型" | 组件测试；手动在开发构建里点一遍 |
| 7 | 回显检查：若 key 会被带出，先写失败测试再修 | `npx vitest run agent-host/src/providers` |
| 8 | L4 用例 E1–E13；a11y 登记与 t43 旅程 | 先 `npm run package:desktop -- --flavor development`，再跑 5.3 的命令、`t43-`，并用 ego-browser 或截图人工过一遍亮暗与中英文 |
| 9 | 文档：ADR-0110、ADR 索引、架构的 ADR 表与第 8.1 节、`apps/desktop/AGENTS.md` | `node scripts/plan/check-acceptance.mjs` |
| 10 | 收尾 | 先提交，再跑 `npm run verify`、`npm run bench:t18` |

## 附录：裁决表

| # | 意见 | 来源 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | 去掉"选择 agent"和单独的项目步 | 产品 | 采纳 | 只有 Pi 一个 harness；新会话页已经承担项目选择 |
| 2 | 触发判定不能用 `providerSettings`（要起设置 Host），改用 settings.json 推导，再加"没有工作区" | 架构、产品、测试 | 采纳 | `provider_settings.rs:55-64`；启动时已读 `userSettings` |
| 3 | 只看 `modelProviders` 存在会误判，`catalogRefresh` 也会写入这个键 | 架构 | 采纳 | `providers.rs:541-551`：改为看 providers 与 accounts 的长度 |
| 4 | L4 抑制：在夹具里预写标记、改造覆盖 settings.json 的 spec（架构），还是加测试用环境变量（测试） | 架构 vs 测试 | 选架构 | 不给生产代码加测试开关。改造约 8 个 spec 是一次性成本 |
| 5 | 先保存后测试，还是新增"测试未保存配置" | 架构 | 采纳先保存后测试 | 后者要改 AHP、Agent Host、NAPI、IPC 与 L1 样本；设置页本来也不校验就保存 |
| 6 | 失败后让用户选"保留未验证"或"移除" | 安全 | 部分采纳 | 保留并明确提示；移除放在连接列表（已有原生确认），引导里不再加一个出口 |
| 7 | 只有测试成功或明确跳过才写完成标记 | 安全 | 部分采纳 | 成功、跳过、稍后设置都写；服务商非空本身就推导为已完成，这一点无法区分，接受 |
| 8 | key 按所选项分开保存，切换时清空；获取模型只在点击时请求；说明写出主机名 | 安全 | 采纳 | 防止 key 被带到另一家或用户随手填的主机 |
| 9 | "获取密钥"地址写死在渲染进程，只收 https | 安全 | 采纳 | `openExternal` 放行任意 http(s) 主机 |
| 10 | 失败原因按纯文本显示；确认回显会不会带出 key | 安全 | 采纳 | 自定义端点不可信；`checks.ts:88-98` 原文返回 |
| 11 | 为 https/回环规则加 THR-04 的对策映射 | 安全 | 不采纳 | 规则已由 Core 测试覆盖，与本需求无关 |
| 12 | "稍后设置"之后要有落点：没有模型时模型按钮显示"连接模型" | 产品 | 采纳（限已打开项目时） | 没有工作区时拿不到模型目录，`useModelCatalog` 需要工作区 |
| 13 | 地区与套餐不能用一个分段控件，改成明确的变体列表，默认值随界面语言 | 产品 | 采纳 | zai、qwen 的组合超出分段控件的容量 |
| 14 | 宫格顺序随界面语言变；只能登录的放在"账号登录" | 产品 | 采纳 | 国内与海外用户的常用服务商不同 |
| 15 | 引导里不选默认模型 | 产品、架构 | 采纳 | 需要新增偏好键，Pi 会自动选 |
| 16 | 成功后直接进新会话页，不要成功页 | 产品 | 部分采纳 | 不做成功页；卡片内显示一行"已连接"（模型与延迟），再点"开始使用"。确认实际可用的模型对新用户有价值 |
| 17 | 已连接的服务商要标出来，替换 key 需明确 | 产品 | 采纳 | `ServiceChooser.tsx:62-63` 有意隐藏已连接项，引导里会静默覆盖 |
| 18 | 庆祝动作、语言切换不做 | 架构、产品 | 采纳 | 不影响需求本身 |
| 19 | 多窗口靠偏好广播同步关闭 | 架构、产品 | 采纳 | `app-shell.ts:80-82` 已经广播 |
| 20 | 托管设置锁定时，本次照样关闭 | 架构 | 采纳 | `managed.rs:307` |
| 21 | 设置打开时引导层隐藏、不卸载，代理设置往返状态不丢 | 架构、测试 | 采纳 | `SignInSection.tsx:487` 直接改 hash |
| 22 | 说明文案按平台分开，不写死 "this Mac" | 测试 | 采纳 | 两个平台都要发布 |
| 23 | `Mascot` 加 `size`/`testId`，避免 testid 重复 | 架构、测试 | 采纳 | `home-mascot.e2e.ts` 依赖这个 testid |
| 24 | 内置服务商在 L4 只测到保存为止；新增测试接口要用户拍板 | 测试 | 采纳只测到保存 | 成功路径由自定义端点与 mock OAuth 覆盖，不新增接口 |
| 25 | 冷启动回归跑 `bench:t18` | 测试 | 采纳 | F2 会等待工作区快照 |
| 26 | 30 px 标题加令牌，或先用 26 px | 架构 | 采纳加令牌 | 欢迎屏的层级需要比新会话页标语更大 |
