# @piarc/desktop

Electron 客户端：主进程只做平台集成与转发，渲染进程只做呈现，业务逻辑在 Core 与 Agent Host（ADR-0013）。Core 加载与事件通道见 T04，Markdown 渲染见 T09。

## 命令

在仓库根目录执行。新机器或 `npm ci --ignore-scripts` 之后先下载 Electron 二进制：`node node_modules/electron/install.js`。

| 命令 | 用途 |
|---|---|
| `npm run start -w @piarc/desktop` | 开发服务器模式（`electron-forge start`，HMR，放宽的开发 CSP） |
| `npm run package:desktop` | 发布构建打包到 `apps/desktop/out/release/`（发布 fuses） |
| `npm run package:desktop -- --flavor development` | 开发构建打包到 `out/development/`，同时生成 `.vite/` 生产构建；L4 前必须运行 |
| `npm run test:e2e -w @piarc/desktop` | L4：两种形态（`dev`、`packaged`）的冒烟与安全用例；`PIARC_EVIDENCE_TASK=Txx` 把证据写到 `tmp/evidence/Txx/l4/` |
| `npm run check:fuses` | 读 `out/release/` 产物的 fuse 与 `fuses.mjs` 比对；`-- --flavor development` 查开发构建 |
| `npx vitest run apps/desktop` | 主进程纯函数的单元测试 |

## 结构

- `src/main/main.ts`：主进程入口，只做生命周期与模块装配。`src/preload/preload.ts`：`window.piarc`。`src/renderer/`：React，入口 `index.html` → `main.tsx`。`src/shared/ipc.ts`：通道名与 `PiarcApi` 类型，三方共用。
- 四个 TS 工程分开：`src/main`、`src/preload` 不含 DOM 类型，`src/renderer` 不含 Node 类型；`tsconfig.config.json` 管 Forge、Vite、Playwright 配置与 `fuses.mjs`，`e2e/` 是 L4。
- 安全基线（架构第 10.3 节，逐条对照见 `docs/spikes/S10-electron-security.md`）：
  - `app-scheme.ts`、`app-protocol.ts`、`asset-path.ts`：`app://piarc` 自定义协议与路径校验；
  - `security/csp.ts`：生产 CSP；`dev-server.ts`：开发服务器模式的全部放宽；
  - `security/navigation.ts`：导航、重定向、新窗口、`<webview>` 守卫；`security/permissions.ts`：权限默认拒绝与放行清单；`security/origin.ts`：origin 计算；
  - `ipc/register.ts`、`ipc/sender.ts`：IPC 注册与来源校验；`external-links.ts`：外链确认；
  - `window.ts`、`web-preferences.ts`：窗口工厂与固定的 webPreferences。

## 不变量

- 新增 IPC 命令：在 `src/shared/ipc.ts` 加通道与 `PiarcApi` 成员，处理函数经 `registerHandler` 注册（ESLint 禁止直接 `ipcMain.handle`），参数当作 `unknown` 校验；同步更新 `e2e/preload.e2e.ts` 的键快照与 S10 报告。
- preload 不暴露 `ipcRenderer`，只能 `require('electron')`（ESLint 禁止 Node 内置模块）；以后的事件 API 必须剥掉 Electron 的 event 对象再交给页面回调。
- 新增权限放行：在 `PERMISSION_ALLOWLIST` 加条目并写 `reason`，补 L4 用例，记入 S10 报告。
- 不得放宽 `PRODUCTION_CSP`。开发服务器模式的放宽只放在 `dev-server.ts`，主进程只在 `import.meta.env.DEV` 下调用，打包时被删除。
- 窗口只经 `createMainWindow` 创建（ESLint 禁止别处 `new BrowserWindow`）；导航与新窗口守卫由 `app.on('web-contents-created')` 装到所有 webContents。
- 外链只放行 `https:`、`http:`、`mailto:`，必须先经原生确认框。
- 主进程比较 origin 用 `originOf`，不用前缀匹配，也不直接用 `new URL(x).origin`。

## 开发构建与发布构建

- fuse 配置的单一来源是 `fuses.mjs`；`PIARC_BUILD_FLAVOR`（由 `package:desktop --flavor` 设置）选择配置，默认 `release`。开发构建只多开 `EnableNodeCliInspectArguments`，L4 的打包形态靠它被 Playwright 驱动。
- `electron-forge start` 用 node_modules 中的 Electron，不写 fuse；界面来自 Vite 开发服务器，开发服务器 origin 加入可信 origin，CSP 放宽三项（见 `dev-server.ts`）。

## 易错点

- `dev` 形态跑的是上次打包生成的 `.vite/`：改了 `src/` 要重新 `package:desktop -- --flavor development`；`electron-forge start` 会清掉 `.vite/renderer`，之后 L4 报 "Production bundle not found"。
- Node 的 `URL` 不认识 Chromium 注册的标准协议：`new URL('app://piarc/').origin` 是 `'null'`。
- 导航被取消后 Playwright 定位器会一直等导航完成：拦截之后用 `page.evaluate` 检查，会触发导航的点击用 `page.mouse.click`。
- 发布构建仍接受 Chromium 的 `--remote-debugging-port`（没有对应 fuse），登记为 I10。

## 参考

- 架构第 3.4、8.1、10.3 节；ADR-0013、ADR-0018 第 1 条；`docs/spikes/S10-electron-security.md`；`docs/engineering/testing.md` 第 9 节。
