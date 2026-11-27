# 0088. 浏览器 guest 进入安全基线

- 状态：已接受（2026-11-26 用户确认）
- 日期：2026-11-26
- 修订：架构 §5.4、§8.5、§10.1（THR-13 第一条措辞）、§10.3"渲染进程不直接访问网络"
- 相关：ADR-0013（Electron 平台）、ADR-0022（渲染进程安全）、ADR-0045（WebFetch）、ADR-0051（终端真实输入）、ADR-0056（沙箱代理）、ADR-0062（安全收口）、ADR-0076（项目文件预览）；[设计增补](../architecture/addenda/browser.md)

## 背景

【预览】工具要成为内置浏览器，用户与智能体在里面打开任意网页。现有基线写的是"应用窗口内不导航到外部页面""渲染进程不直接访问网络""窗口禁止导航到应用自身协议以外的地址"，并由 `guardWebContents` 经 `web-contents-created` 作用于所有 webContents（`apps/desktop/src/main/security/navigation.ts`）。这些条款保护的是加载 `app://piarc` 的应用界面；一个承载网页的视图与它们直接冲突。

2026-11-26 的 spike（Electron 45.3.2）确认：`web-contents-created` 触发时 `contents.session` 已是视图的分区；`session.webRequest.onBeforeRequest` 支持异步裁决并带 `webContentsId`；CDP 合成的输入会触发 `input-event`；Chromium 的本地网络访问保护没有生效（被标为公网的页面读到了 loopback 上的数据）。

## 决策

1. **新增一类 webContents：浏览器 guest。** guest 是主进程 `BrowserService` 创建的 `WebContentsView`，只存在于浏览器分区（`persist:piarc-browser-<工作区哈希>` 或退出即清空模式的内存分区）。应用窗口、工具窗口、项目预览仍属于工作台，原有条款对它们不变。不使用 `<webview>`，`will-attach-webview` 继续一律取消。
2. **按分区识别，不靠登记。** `web-contents-created` 里按 `contents.session` 是否属于浏览器分区分流：guest 走 `guest-guard`，不走 `guardWebContents`；guest 不进 `terminalOwners`，它的 `input-event` 永远不计入工作台的真实输入；浏览器分区里出现的、不是 `BrowserService` 创建的 webContents 立即关闭。
3. **guest 的 webPreferences 固定。** `sandbox`、`contextIsolation`、`webSecurity` 开启，无 Node、无 preload，`plugins` 开启（只为内置 PDF 查看器），`navigateOnDragDrop` 关闭。guest 的任何 IPC 都被 `ipc/register.ts` 拒绝。
4. **guest 守卫。** 顶层导航允许 http、https、`piarc-browse:`（工作区文件，经 Core 句柄读）、`data:`、`blob:`、`about:blank`；`file:`、`app:`、`piarc:`、`chrome:`、`devtools:` 与其他自定义协议拒绝（`mailto:` 经现有外链确认）。弹窗转为同一 Space 的新标签。权限、设备选择、客户端证书默认拒绝，用户控制的标签上可在面板 DOM 里逐次允许（不持久化）；证书例外只对 loopback 与私网、只认真实输入。
5. **浏览器出网经 Core 的浏览器代理。** 每个浏览器分区设 `session.setProxy`（`proxyBypassRules: '<-loopback>'`）到一个 `piarc_sandbox::NetworkProxy` 实例，主机白名单为 `*`，地址检查用浏览器策略：元数据、链路本地、未指定地址永远拒绝；loopback 与私网只允许 IP 字面量、`localhost` 与本地开发域名（设置 `browser.localHostnames`）；PiArc 自己的监听端口拒绝。WebRTC 设为 `disable_non_proxied_udp`。用户配置的上游代理由它转发。
6. **措辞修订。** THR-13 第一条改为"应用窗口禁止导航到应用自身协议以外的地址"；§8.5、§5.4 的"应用窗口内"保持原意并注明不含浏览器 guest；§10.3 增加"浏览器 guest 的网络经 Core 浏览器代理"。`docs/security/egress.md` 增加"内置浏览器"一行。新增 THR-16（浏览器外传与本机服务访问）、THR-17（浏览器凭据），对策与测试进 `tests/security/threats.yaml`。
7. **发布构建不变。** 不开远程调试端口与管道；CDP 只经进程内 `webContents.debugger`，只挂在 guest 上。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `<webview>`（ZCode 路线） | DOM 浮层可盖住页面，不用同步矩形 | 违反 §10.3；主窗口要开 `webviewTag`；ZCode 记录了 capturePage 崩溃、CDP UAF、焦点竞争等一长串问题 | 否决 |
| 用户的系统浏览器（扩展或外连 CDP） | 不改基线 | 智能体操作用户真实浏览器；需要远程调试端口或扩展；不能嵌入面板 | 否决 |
| 只用 `webRequest` 做主机裁决，不加代理 | 少一个组件 | 只看主机名，挡不住 DNS 重绑定与解析到元数据地址的域名；Electron 45 的本地网络访问保护未生效 | 否决 |
| guest 用 `defaultSession` | 简单 | 与应用共享 cookie、CSP 注入与权限策略；开发构建下 guest 可能被当作可信源 | 否决 |

## 后果

- 正面：应用窗口的基线不变；网页有独立的网络出口与地址检查；guest 无法触达应用 IPC 与真实输入判定。
- 负面与代价：每个标签一个渲染进程；浏览器流量多一跳本机代理；HTTP/3 不可用；PDF 查看器需要 `plugins`。
- 需要配套做的事：架构正文与威胁表、egress 与 Electron 清单、`t45-egress` 新用例、`t45-browser-isolation`、`apps/desktop/AGENTS.md` 的安全基线一节。

## 重新评估的触发条件

- Electron 启用 Chromium 的本地网络访问保护，且 guest 权限处理器能拒绝它时，评估去掉代理的地址检查；
- 出现能让页面伪造 `input-event` 或绕过分区识别的方式；
- Electron 提供按 webContents 设置代理，评估把主机裁决也移到代理。
