# 0092. 启动配置与开发服务器（补充）

- 状态：已接受（补充）
- 日期：2026-11-26
- 相关：ADR-0005、ADR-0038（Claude Code 配置只读）、ADR-0025、ADR-0029（信任与可执行项）、ADR-0049（任务）、ADR-0056（沙箱）、ADR-0089；[设计增补 B4](../architecture/addenda/browser.md)

## 背景

前端自验证需要开发服务器。Claude Desktop 用 `.claude/launch.json` 描述并启动服务器；PiArc 已有后台任务（`TaskManager`）与进程树管理。浏览器的端口策略（ADR-0089 第 5 条）也需要知道"本会话启动的进程在听哪些端口"。

## 决策

1. **配置来源**：`.piarc/launch.json` 与 `.claude/launch.json`（JSONC，字段同 Claude Desktop：`configurations[]` 的 `name`、`runtimeExecutable`/`runtimeArgs`、`program`/`args`、`cwd`、`env`、`port`、`autoPort`、`url`，顶层 `autoVerify`）；同名时 `.piarc` 优先；`.claude/launch.json` 只读。解析在 `piarc_config::launch`。启动配置是项目可执行配置：项目受信任才可启动，新增或改动的配置计入未确认可执行项。
2. **服务是任务**：新增 `TaskKind::DevServer`，在会话的命令环境与进程树启动器下运行，日志、停止、退出与 Bash 后台命令一致；不进 Bash 沙箱（要绑定端口）。
3. **谁能启动**：用户在面板里点击运行不审批；智能体经浏览器绑定 `startServer(name)` 启动时，按配置指纹（命令、参数、cwd、env、端口的 SHA-256）每个会话问一次，配置改动后重新问；任何模式都问。
4. **端口**：`port` → `url` 的端口 → `env.PORT` → 参数 `--port`/`-p` → 3000；`autoPort` 为真时被占用则向上找 20 个空闲端口并改写参数与 `PORT`；就绪为 127.0.0.1 与 ::1 的 TCP 连通且监听进程属于该任务进程树（250 ms 间隔，180 s 超时）。
5. **端口发现**：`piarc_core::ports` 按会话的后台任务、终端、开发服务器进程树查询监听端口（macOS `lsof`，Windows `GetExtendedTcpTable`），变化经 `core/browser` 的 `ports` 推送；同一结果供浏览器端口策略与面板提示使用。
6. **`autoVerify`**（默认真）：本会话有运行中的开发服务器、且智能体改动了该服务目录下的前端文件时，下一轮带一次 `browserVerify` 提醒。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只读 `.claude/launch.json` | 零新格式 | PiArc 用户无处写自己的配置；`.claude/` 不可写（ADR-0038） | 否决 |
| 不做启动配置，只靠 Bash 后台命令 | 无新概念 | 用户无法在面板里一键启停；端口与就绪判定分散 | 否决 |
| 端口发现扫描全部本机端口 | 不需进程树 | 把本机其他服务当成开发服务器，削弱端口策略 | 否决 |

## 后果

- 正面：面板与智能体共用一套服务与端口事实；端口策略有依据。
- 负面与代价：新 `TaskKind` 与平台相关的端口查询；配置诊断增加一类来源。
- 需要配套做的事：配置诊断来源、信任快照的可执行项、L2 `devserver-`、L4 `browser-devserver`。

## 重新评估的触发条件

- Claude Code 的 launch.json 格式变化；
- 需要容器或远端开发服务器（端口不在本机进程树里）。
