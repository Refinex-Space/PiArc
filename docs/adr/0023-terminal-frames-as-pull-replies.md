# 0023. 终端帧作为拉取请求的返回值送达渲染进程，不经事件 MessagePort

- 状态：提议
- 日期：2026-11-15
- 取代：无
- 修订：ADR-0017 第 3 条（"编码成二进制 `ArrayBuffer`，经 MessagePort 送到渲染进程"）
- 相关：架构文档第 6.11、7.6、8.3、11 章；ADR-0017、ADR-0019；`docs/spikes/S07-terminal.md`；T10-A10

## 背景

ADR-0017 第 3 条规定：渲染进程按 `requestAnimationFrame` 节奏拉取终端帧，帧经 MessagePort 送到渲染进程。T10 照此实现：页面经 `ipcRenderer.invoke` 发出拉取请求，主进程拿到 Core 的帧后放到该窗口的事件端口（T04 的通道）上，preload 再交给页面。

S7 要求键入回显的额外延迟 p95 ≤ 5 ms（架构第 11 章）。实测这条路径不达标，原因在 Chromium 的调度，不在 Core 或渲染器。

事实（Electron 45.3.2，开发构建的打包形态，Apple M1 Max、macOS 26.5.2，2026-11-15；数据在 `tmp/evidence/T10/bench/`）：

- 管线本身很快：页面在普通任务里发出"按键 + 拉取"，0.4–0.5 ms 内就收到含回显的帧；Core 直接写 PTY 到读回回显 p50 0.02 ms。
- 在 `keydown` 处理函数里发出同样两次调用时，`invoke` 自身 0.2–0.7 ms 就返回，但经 MessagePort 送来的帧要到下一帧的 rAF 回调之后才被处理（6.2–14.2 ms）。用 `webContents.sendInputEvent` 注入按键（与系统键盘事件走同一条 RenderWidgetHost 路径）结果相同，所以不是 CDP 合成输入的特殊情况。
- 推断：Blink 主线程调度器在离散输入之后优先完成下一帧的渲染，期间推迟 posted message（MessagePort）类任务；IPC 回复所在的任务队列不受影响。这是根据上面的对照得出的结论，没有查到 Chromium 的对应文档，以实测为准。
- S7 基准（`npm run bench:s7`，200 个配对样本，`cat` 中键入）：
  - 帧经 MessagePort：键盘事件到解码出含回显的帧 p50 12.70 ms、p95 16.20 ms，额外延迟 p95 16.18 ms，不达标；
  - 同一构建只把帧改为 `invoke` 的返回值（临时改动，未提交）：p50 0.50 ms、p95 0.80 ms，额外延迟 p95 0.77 ms。
  - 两种方式下 `cat` 100 MB 的主进程事件循环延迟 p99 都约 1.9 ms，渲染进程都没有超过 50 ms 的任务。

换成 xterm.js 退路（ADR-0017 第 7 条）也解决不了：退路同样要把数据从主进程送到渲染进程，经 MessagePort 就有同样的推迟。

## 决策

1. 终端帧作为渲染进程拉取请求的返回值送达：`window.piarc.requestTerminalFrame(id, full)` 解析为这一帧（`ipcRenderer.invoke` 的回复），不再经事件 MessagePort 投递，preload 去掉 `onTerminalFrame`。
2. 其余不变：主进程只校验参数与终端归属、不解析帧；帧以二进制载荷经结构化克隆复制（ADR-0019）；渲染进程每个动画帧最多一个在途请求，隐藏的终端不请求；输入之后连续拉取直到回显到达（最多 50 ms）。
3. 事件 MessagePort 继续承担推送：终端的标题、响铃、退出事件（路由 `term/<id>`）和会话事件都不变。
4. ADR-0017 第 3 条的"经 MessagePort 送到渲染进程"改为"作为拉取请求的返回值送到渲染进程"；架构第 6.11、8.3 节同步。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 帧作为 `invoke` 的返回值（本决策） | 改动只在主进程处理函数与 preload；实测额外延迟 p95 0.77 ms；拉取语义更直接（一次请求一次回复） | 帧不再走 T04 的事件通道；需要改 ADR-0017 第 3 条 | 提议采纳 |
| 保持 MessagePort | 符合 ADR-0017 原文，复用事件通道 | 输入之后的帧被推迟到下一帧之后，额外延迟 p95 16 ms，超出预算三倍 | 否决 |
| 主进程用 `webContents.send` 主动推送帧 | 不经 MessagePort | 违背拉取模型（Core 或主进程要知道何时推）；隐藏终端不产生帧要另行保证；未实测 | 否决 |
| 渲染器移到 Worker（`OffscreenCanvas`），帧经端口直达 Worker | Worker 线程不受主线程输入调度影响；绘制不占主线程 | 改动大：渲染器、字体度量、输入法预编辑的绘制都要跨线程协作；超出 M0 | 不在 M0 采用；T34 若遇到主线程绘制瓶颈再评估 |
| 本地回显预测（页面先画出键入的字符） | 显示快 | 与终端的真实回显（密码输入、raw 模式程序）不一致，违背"Core 是唯一权威" | 否决 |

## 后果

- 正面：键入回显的额外延迟满足第 11 章预算；拉取请求与回复一一对应，渲染进程不用再按终端 id 分发帧。
- 负面与代价：帧与事件走两条路（帧走 IPC 回复，事件走 MessagePort），主进程里多一个返回 Promise 的处理函数；每次回复仍复制一次帧（与 MessagePort 相同）。
- 需要配套做的事：
  - 采纳后：改 `apps/desktop/src/main/core/terminal-ipc.ts`（返回 Core 的 Promise）、`src/preload/preload.ts`（`requestTerminalFrame` 解析为帧，去掉 `onTerminalFrame`）、`src/shared/ipc.ts`、渲染进程控制器与 L4 用例，重跑 `npm run bench:s7` 并更新 T10-A10 与 S7 报告；
  - ADR-0017 注明第 3 条被本 ADR 修订，架构第 6.11、8.3 节同步，修订记录写一条；
  - T34 的终端面板沿用这种送达方式。

## 重新评估的触发条件

出现以下任一情况时复核本决策：

- Electron 或 Chromium 升级后，IPC 回复在输入之后同样被推迟，或 MessagePort 消息不再被推迟（S7 基准可复测）；
- 单帧回复的复制耗时在性能测试中 p95 超过 5 ms；
- 渲染器移到 Worker 或改用其他绘制方式。
