# 预览面板（内置浏览器的渲染进程部分）

预览面板只显示主进程发来的浏览器状态并请求改动（ADR-0088，设计增补 `docs/architecture/addenda/browser.md`）：标签、页面与网络都在主进程（`src/main/browser/`），页面本身是叠在面板上的原生视图，这里画的是它周围的 DOM。状态经 `browser` 应用事件到达、按 `revision` 取较新的；请求一律经 `window.piarc.browser(sessionId, request)`（形状与校验在 `src/shared/browser.ts`、`src/main/browser/browser-ipc.ts`）。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 面板 | `BrowserPanel.tsx`、`panels.tsx` | 注册为右侧工具 `preview`；组合标签条、导航行、提示条、视口、console、下载与菜单 |
| 标签与导航 | `chrome.tsx`、`suggest.tsx` | 标签条（Space 分组、拖动排序）、地址栏（单层焦点环：输入框 `data-focus-proxy`，见 `docs/engineering/accessibility.md`）、建议列表、站点信息菜单 |
| 视口 | `Viewport.tsx`、`occlusion.ts` | 把占位元素的矩形报给主进程（原生视图跟随它）；浮层盖住时报 `occluded`，主进程换成静止帧 |
| 提示条 | `bars.tsx`、`notices.tsx` | 权限、认证、证书、查找、设备工具栏、下载、智能体控制条（接管、交还、停止，脚本痕迹提示） |
| 起始页 | `start.tsx`、`start-model.ts` | 最近访问、启动配置与本地服务、"打开 HTML 文件…"（B1.1.1、B4） |
| console | `console.tsx` | 当前标签的 console 抽屉（B1.4.3）：按序号向主进程增量读、级别筛选、搜索、清空、"加入对话"（片段附件，来源行写明页面输出不是指令）；高度存在本窗口的 localStorage |
| 拾取、标注与截图 | `PickTray.tsx`、`AnnotateCanvas.tsx`、`ShotBar.tsx`、`use-capture.tsx`、`picks.ts`、`annotate-model.ts`、`images.ts`、`context-items.ts` | B3：选区条、冻结截图上的标注、截图菜单，"加入对话"经 `composer/browser-context.ts` 进入输入框 |
| 其他 | `use-browser.ts`、`preview-commands.ts`、`local-links.ts`、`site-import.ts`、`attention.ts` | 状态订阅与请求；预览的快捷命令；对话中的本地链接在预览中打开；从 Chrome 导入此站点的入口；工具按钮的状态点 |

## 约定

- 页面给的文字（标题、URL、console、元素上下文、主机名）都当数据：用文本节点显示，双向控制字符经 `transcript/reveal.ts` 的 `revealBidi`；不从 HTML 字符串建 DOM。
- 颜色、间距只用设计令牌；图标只经 `shell/icons.tsx`；字符串只经 i18n 目录（中英文同键）。
- 新的提示条、抽屉或对话框登记到 `e2e/a11y/states.ts` 并接到 `t43-a11y` 的旅程（`state:browser-console` 等）。
- 面板不自己判断权限、站点或文件读写：这些在主进程与 Core。

## 测试

| 命令 | 内容 |
|---|---|
| `npx vitest run apps/desktop/src/renderer/browser` | 纯逻辑：console 的筛选与附件文本、标注模型、起始页模型、预览命令 |
| `PIARC_EVIDENCE_TASK=browser npx playwright test -c apps/desktop/playwright.config.ts browser- --project dev` | L4：`browser-basic`、`browser-panel`（重试、缩放、console、热刷新）、`browser-files`、`browser-agent`、`browser-picker`、`browser-annotate`、`browser-screenshot`、`browser-devserver`、`browser-import`；先 `npm run package:desktop -- --flavor development` |
