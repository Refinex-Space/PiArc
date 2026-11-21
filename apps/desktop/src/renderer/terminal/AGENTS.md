# 终端渲染器与终端面板（T10、T34）

渲染进程只画 Core 的帧（ADR-0017、0023、0051）：终端状态、选区、滚动、按键与鼠标编码都在 Core 的 libghostty-vt，这里不解析 VT、不保存终端业务状态。路线是 S7 结论的正式路线（fork 的 Canvas 渲染器），没有启用 xterm.js 退路。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 视图 | `controller.ts` | 一块画布加一个隐藏 textarea：拉帧循环、停拉与唤醒、按宿主尺寸适配网格、设备像素比变化、光标闪烁、主题颜色、L4 探针 `probe()` |
| 输入 | `input.ts`、`keys.ts` | 键盘归属、复制粘贴、输入法守卫与预编辑；按键以事件原样交给 Core 编码 |
| 指针 | `pointer.ts`、`links.ts` | 鼠标事件交给 Core（选区或程序的鼠标跟踪），滚轮按行步进；Mod+点击打开链接（OSC 8 问 Core，普通 URL 在行文本中识别） |
| 帧 | `frame/` | 帧格式第 2 版的 TS 解码器与 `Screen`，与 Rust 跑同一组样本 |
| 渲染 | `remote-renderable.ts`、`vendor/ghostty-web/` | fork 的 `CanvasRenderer`（MIT，改动清单在其 README，登记在 `third-party/sources.json`） |
| 面板 | `TerminalPanel.tsx`、`TerminalSurface.tsx`、`panel-state.ts`、`events.ts`、`panels.tsx` | 停靠区的标签、共享开关、查找、以文本查看屏幕、附加到消息；`term/<id>` 事件经 `events.ts` 统一订阅 |
| 纯函数 | `search.ts`、`links.ts`、`theme.ts` | 查找高亮与跳转、URL 识别、令牌颜色解析 |
| 原型页 | `TerminalLab.tsx` | `#/terminal-lab`，只给 L4 与 S7 基准用，终端由测试钩子创建 |

## 帧拉取节奏

- 只在 rAF 回调中拉，每个终端每窗口至多一个在途请求（主进程也拒绝第二个）；输入后连续拉取直到回显，至多 `EAGER_MS`（50 ms）。
- 连续 `PARK_AFTER`（8，`shared/terminal-lab.ts`）个空帧后带 `park` 拉取，仍为空就停拉并停 rAF；Core 的 `output` 事件、输入、尺寸、滚动、焦点唤醒。`held` 帧不算空。
- 不可见不拉：IntersectionObserver、`document.visibilityState` 与主进程的 `visibility` 应用事件（`app/window-visibility.ts`，最小化窗口的 rAF 在 Electron 中仍会跑）。
- 面板只挂载可见标签的 `TerminalSurface`；换标签、重新打开面板或重载都以 RESET 帧开始。

## 输入、快捷键与输入法

- 终端获得焦点时按键都交给终端，只有 `shared/keybindings.ts` 中 `global: true` 的命令（Ctrl+\`、Ctrl+Tab、Mod+,）不处理、留给窗口；macOS 的 ⌘ 组合键不进终端。`keyIntent` 是唯一的判定。
- 复制：macOS ⌘C；Windows Ctrl+Shift+C，或有选区时的 Ctrl+C（无选区时发给程序）。文字来自 Core 的选区（`terminalSelectionText`）。粘贴走浏览器的 paste 事件，Core 包装；`unsafe` 结果先由面板确认。
- 只有被发给终端的按键才发松开事件；合成中的按键（`isImeComposing`）不发。预编辑由渲染器画在光标处，`compositionend` 只写一次上屏文本；其后的 input 事件不重复写入。
- textarea 每次绘制后移到光标格（CSS 像素 = 设备像素 / 比例），系统的候选框据此定位。

## 不变量

- 主进程对写入、打开与共享要求窗口近期真实输入（ADR-0051）：L4 必须用 Playwright 的键盘、鼠标或 CDP 输入驱动，在页面里直接调 `window.piarc.terminalInput` 会被拒绝。
- 格子尺寸与指针坐标按设备像素交给 Core（`deviceCell`），textarea 与面板布局用 CSS 像素（`cell`）。
- 颜色：默认前景、背景、光标从组件令牌 `--piarc-c-terminal-*` 读出并经 `terminalColors` 交给 Core；选区与查找色只在渲染器使用。不要在这里写颜色字面量（`theme.ts` 与 `TerminalSurface` 的后备值除外）。
- 改 `vendor/ghostty-web/` 要同步其 README 的改动清单，保留 MIT 声明；改帧格式按 `crates/piarc-term/AGENTS.md` 重写共享样本。

## 测试

- 单测：`npx vitest run apps/desktop/src/renderer/terminal`（解码与样本、键位、输入归属与输入法、URL、查找）。
- L4：`PIARC_EVIDENCE_TASK=T34 npx playwright test -c apps/desktop/playwright.config.ts t34- --project dev`（面板、选区复制、查找、链接、共享、重载、无障碍与 axe、vim/top/less 与缩放、vim 的键鼠与 bracketed paste、隐藏与最小化不拉帧、输入法），原型页是 `terminal.e2e.ts`、`terminal-tui.e2e.ts`；测量 `npm run bench:s7 -- --form packaged`。

## 易错点

- 双击、三击靠 `mousedown` 的 `detail`：pointer 事件的 `detail` 为 0，所以指针用鼠标事件，拖动期间在 window 上收 move 与 up。
- axe 在 Electron 里不能新开页面：`new AxeBuilder({ page }).setLegacyMode(true)`。
- `:root[data-app] button { color: inherit }` 的优先级高于单个类选择器：给按钮设颜色时写在 `:root[data-app]` 下。
- 测试机没有 htop，全屏重绘用 top 代替（与 T10 相同）；用户的 zsh 配置会出现在会话终端里，断言用整行精确匹配或程序计算出的文本。
