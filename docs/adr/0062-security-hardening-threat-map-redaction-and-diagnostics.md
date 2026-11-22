# 0062. 安全收口：威胁映射进 verify、日志写入时脱敏、诊断包先预览后写出、发布构建拒绝远程调试、Pi 自己的包清单不生效（补充）

- 状态：已接受（补充）
- 日期：2026-11-22
- 取代：无
- 相关：架构文档第 9.3、10.1、10.3、10.5、12.1、13.3 节；ADR-0004、ADR-0006、ADR-0015、ADR-0018、ADR-0029、ADR-0058；需求 NFR-03、NFR-04

## 背景

M4 的退出标准要求第 10.1 节的威胁"逐条有测试"，对策却散在 T03 到 T44 的各个任务里，没有一处能证明每条都被测到。T45 建立映射并补测试时还发现了几处缺口：

- Pi 1.5.2 的资源加载器每次重载都会安装 Pi 设置里 `packages` 列出的缺失来源：npm 不带 `--ignore-scripts`，git 克隆后在包里运行 `npm install`。只有 `PI_OFFLINE` 能阻止，L2 与会话测试设了它，应用没有设，它同时会关掉 Pi 的远程模型目录。受信任项目的 `.pi/settings.json` 与用户级 `pi/settings.json` 因此能在 Agent Host 里运行安装脚本，违背 ADR-0058 第 4 条。macOS 上项目作用域的安装被 Agent Host 的 Seatbelt 配置挡住（`.pi/` 只读），用户作用域与 Windows 没有。
- Chromium 的 `--remote-debugging-port` 没有对应的 fuse，发布构建照样接受（I10）。
- 日志不脱敏：服务商错误原文、hook 输出与 Agent Host 的 stderr 原样进入 `<数据目录>/logs/`（I57）。
- 测试页随发布构建分发（I13、I24、I30）。
- 审批卡把 U+202E 等双向控制字符原样显示：文件 `x ‮gnp.md` 读作 `x dm.png`，命令可以被同样伪装。

## 决策

1. **威胁映射是数据，进 verify。** `tests/security/threats.yaml` 每条威胁一个 `THR-NN`，标题与第 10.1 节的威胁列一致；第三列按 `；` 拆出的每个对策都要被映射。对策分自动化（至少一个测试 ID）、流程（理由与检查项）、已接受风险（理由与 ADR 或登记事项）、待补（理由与负责的任务；该任务完成后检查失败，迫使映射更新）。测试 ID 的形式是 `cap:<能力 ID>`、`rust:`、`vitest:`、`l4:` 加文件与名称、`ci:<脚本>[#<检查>]`、`process:<文件>#<标记>`，由 `scripts/ci/check-threats.mjs` 对照仓库里的源文件解析；名称以 `THR-NN`（Rust 为 `thrNN_`、L2 描述以 `THR-NN.` 开头）开头的测试必须映射到该威胁。`docs/security/threat-coverage.md` 由脚本按映射与 L2 结果生成（verify 第 17 步检查漂移）。
2. **日志写入时脱敏。** `piarc-telemetry::redact` 在日志写入器里处理每一行：Core 从保险箱读出的每个凭据值（Core 在每次保险箱操作后登记，至少 12 个字符且不含空白的字符串）、服务商 key 前缀、云厂商 access key id、`Bearer`/`Basic` 凭据、JWT、名字表明是密钥的字段值与 URL 里的密码，都换成 `[REDACTED:<类别>]`。Agent Host 的 stderr 经同一个写入器，不另做处理。
3. **诊断包先预览后写出。** Core 在内存里组装（日志、版本、用户级设置文件、工作区的配置诊断；设置与诊断里名字表明是密钥的键、`env` 与 `headers` 的值也替换；主目录写作 `~`），客户端展示文件清单、按类别的替换计数与永不包含的内容；用户点"导出…"后，主进程弹原生保存对话框，Core 才把同一份内容写成 ZIP（stored 条目，附 `manifest.json`）。保险箱、数据库、会话内容、检查点与 Agent Host 的目录不进诊断包。
4. **发布构建拒绝远程调试开关，不带测试页。** 主进程在 `ready` 之前移除 `--remote-debugging-port`、`--remote-debugging-pipe` 并退出；测试页放在只有开发构建生成的 chunk 里。两者都由构建期常量 `__PIARC_RELEASE_BUILD__` 决定，它只在 `npm run package:desktop` 打发布构建时为真；开发构建保留两者，供 Playwright 与基准使用。
5. **Pi 自己设置里的包清单不生效。** Agent Host 交给 Pi 的设置读取不含 `packages`（两个作用域），Pi 的包管理器什么都不装、不加载；扩展包只经 PiArc 的扩展包（ADR-0058）。受信任项目的 `.pi/settings.json` 里的 `packages` 从此不加载，信任清单仍把它们列为可执行项（只多不少）。
6. **依赖安全有独立的流水线与例外清单。** `npm run audit:deps` 运行 `npm audit`、cargo-audit（锁定版本装在 `.tools/`）、cargo-deny 的 advisories 与 licenses、npm 发布依赖的许可证检查；高危与严重的 npm 公告和任何 cargo 漏洞没有现行例外即失败。例外写在 `tests/security/audit-exceptions.yaml`（理由、影响、复查日期），过期即失败。`deps-security.yml` 在依赖改动与每天运行。新增依赖的评审是 PR 模板的检查项。
7. **审批卡与 diff 显示双向控制字符。** 审批卡的命令、路径与 diff，Changes 的文件名与 diff，transcript 的文件路径与代码高亮，把双向格式字符显示为 `[U+XXXX]`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 映射写在文档里，人工维护 | 简单 | 删掉一条或测试改名没人知道 | 否决，A01 要求 verify 能发现 |
| 导出诊断包时才脱敏 | 日志原文保留，排错信息多 | 日志文件本身留着凭据，任何读日志的进程都能拿到 | 否决，写入时就替换，导出时再查一遍 |
| 设 `PI_OFFLINE=1` 阻止 Pi 装包 | 一行环境变量 | 同时关掉 Pi 的远程模型目录，`modelProviders.catalogRefresh` 失效 | 否决 |
| 信任决定也走原生确认（I79） | 被注入的渲染进程不能静默信任项目 | 每个新工作区多一次确认，改变 ADR-0029 的决定 | 不在本 ADR，交 R5 由用户决定 |
| 发布构建的远程调试开关只移除不退出 | 应用照常启动 | 带这个开关启动 PiArc 的只有调试者或攻击者，照常启动掩盖了异常 | 否决，移除并退出 |

## 后果

- 正面：每条威胁有可检查的测试；凭据不进日志与诊断包；发布构建不能被远程调试驱动；Pi 不会绕过 ADR-0058 运行安装脚本；依赖公告每天检查。
- 负面与代价：verify 多一步（约 1 s）；脱敏的正则在每条日志上运行（单行微秒级）；`.pi/settings.json` 的 `packages` 不再生效，需要它的用户改用 PiArc 的扩展包；minimatch 的中危公告暂留在例外清单（eslint 10.15 与 typescript-eslint 8.73 的新规则对 Electron 类型误报）。
- 需要配套做的事：T50 实现更新流程后为 THR-09 补测试并去掉"待补"；新增安全对策登记到映射（`docs/engineering/testing.md` 第 16 节）；新增外连写入 `docs/security/egress.md`。

## 重新评估的触发条件

- 第 10.1 节的结构改变（不再是三列表，或对策不再以 `；` 分隔）；
- Pi 的包管理器改为在资源加载之外安装，或提供关闭自动安装而不关模型目录的开关；
- Electron 提供关闭远程调试的 fuse；
- 脱敏的误报影响排错（日志里出现大量本不是凭据的替换）。
