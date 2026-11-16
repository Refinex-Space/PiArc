# S4 Operations 委托与规范名工具

- 任务：T07（2026-11-15）
- 范围：Pi 的内置工具能否经 Operations 把 I/O 全部交给 Core；能否改为 Claude Code 的规范名、换上 PiArc 自写的描述，而行为与 Pi 原生一致（架构第 6.1.1、6.1.3 节，ADR-0004）。本任务把 Glob、Grep 也纳入。
- 结论：macOS **通过**。Read、Write、Edit、Bash、Glob、Grep 六个规范名工具的文件与命令 I/O 全部经 AHP 到 Core；场景运行期间 Agent Host 进程对工作区路径的 `fs` 调用为 0、`child_process` 调用为 0；16 个对照场景与 Pi 原生工具结果一致，1 项有意差异；小文件 `fs/read` 往返 p95 约 0.2 ms。Pi 1.5.2 的 Operations 本身**不足以**做到零绕过：read、write、edit 在 Operations 之外探测路径，grep 直接运行 ripgrep。前三者改用"替身路径"运行 Pi 的工具代码，Grep 改为 PiArc 自写的同名工具（ADR-0020）。Windows **通过**（W0 本机复跑，第 11 节）。

## 1. 验证环境

| 项 | 版本 |
|---|---|
| 系统 | macOS 26.5.2（25F84），Apple M1 Max |
| Node | 本机 24.14.1；CI 用 `.nvmrc` 的 24.22.2 |
| Pi | `@earendil-works/*` 1.5.2 |
| Agent Host | `npm run build:agent-host` 的单文件 bundle（约 15 MB） |
| Core | `piarc-core::tool_io::ToolIo`（`piarc-fs`、`piarc-exec`），经 `piarc-core::agent_host::start` 监管 Agent Host，Rust 1.99.1 |
| Core 侧库 | `ignore` 0.4.34、`globset` 0.4.21、`grep-searcher` 0.1.17、`grep-regex` 0.1.14、`sha2` 0.11.1 |
| 对照用 | ripgrep 15.2.0、fd 10.5.0（`node scripts/dev/install-tools.mjs` 装进 `.tools/bin`，只供 Pi 原生 grep、find 使用） |
| 模型侧 | `piarc-testkit` 严格 mock provider，Anthropic Messages 线格式 |

## 2. Pi 各工厂的 Operations 覆盖情况

逐个读了锁定版本 `dist/core/tools/` 的实现，结果如下。"Operations 之外"指工具代码在本进程直接调用 `fs` 或 `child_process` 的地方。

| Pi 工具 | Operations 覆盖 | Operations 之外的本地访问 | PiArc 的做法 |
|---|---|---|---|
| read | `access`、`readFile`、`detectImageMimeType`、`createReadStream` | `resolveReadPathAsync` 用 `fs.access` 探测路径及其 macOS 拼写变体（AM/PM 前的窄空格、NFD、弯引号），最多 5 次 | 替身路径（第 3 节）；拼写变体由 Agent Host 列出、Core 的 `fs/stat` 逐个确认 |
| write | `mkdir`、`writeFile` | `withFileMutationQueue` 调 `realpath` 求队列键 | 替身路径；同一文件的写入由 PiArc 自己的队列串行 |
| edit | `access`、`readFile`、`writeFile` | 同 write | 同 write |
| bash | `exec` | 无（给了 `operations` 就不创建本地 shell 后端；截断时的完整输出写在系统临时目录） | Pi 工厂 + `BashOperations` → `exec/run` |
| find | `exists`、`glob` | 只在没有自定义 `glob` 时运行 fd、向上找 `.git` | Pi 工厂 + `FindOperations` → `fs/stat`、`fs/glob` |
| grep | `isDirectory`（`readFile` 自 1.5.1 起被忽略） | 总是直接 spawn ripgrep，匹配行与上下文都来自 ripgrep | PiArc 自写的同名工具：沿用 Pi 的参数 schema 与输出格式，搜索走 `fs/grep` |
| ls | `exists`、`stat`、`readdir` | 无 | 没有规范名，默认 Profile 不暴露；`lsOperations` 经 `fs/stat`、`fs/list` 实现并有单元测试 |

其他在 Operations 之外的行为：read 的图片缩放用 photon（WASM，进程内内存，不碰文件）；bash 的输出截断把完整输出写到系统临时目录（不在工作区）。Pi 的会话 JSONL 写在 PiArc 数据目录的 `pi/sessions/`。

## 3. 替身路径

read、write、edit 的探测只依赖传给工具的 `path` 字符串。PiArc 的 Read、Write、Edit 先按 Pi 的规则把模型给的路径解析成绝对路径（`@` 前缀、Unicode 空格、`~`、`file://`、Git Bash 盘符路径，移植自 Pi 的 `utils/paths.ts`），再把一个**替身路径**交给 Pi 的工具定义：`<系统临时目录>/piarc-stand-in/<uuid>/<文件名>`，从不创建。

- Pi 的探测落在替身上：`access` 与 `realpath` 得到 ENOENT，按 Pi 自己的逻辑继续，没有一次触及工作区。
- Pi 对替身调用的每个 Operation（替身本身或它的目录），由 Core 对真实路径执行。
- Pi 的结果与错误中出现的替身路径，换回模型自己写的路径；Node 风格的错误（`ENOENT: no such file or directory, access '<路径>'`）由 Agent Host 按 Core 的错误码重建，路径用工具请求的路径，所以模型看到的文字与 Pi 原生相同。
- 读取时先用 `fs/stat`（带图片嗅探）确认路径及其拼写变体，`access` 与 `detectImageMimeType` 直接用这一次的结果，小文件一次 Read 是 `fs/stat` + `fs/read` 两次往返。

代价：每次调用在系统临时目录下多几次失败的 `access`/`realpath`；Pi 的 `withFileMutationQueue` 按替身路径排队而失去串行作用，PiArc 用自己的队列（按词法绝对路径，Windows 上不区分大小写）串行 Write 与 Edit。第三方扩展若用 Pi 的队列写同一文件，不与这两个工具串行；T16 的文件状态表会覆盖这个缝隙。

考虑过的另一条路是完整移植 read（约 300 行）、edit 的匹配与 diff（约 500 行）。替身路径保留 Pi 的全部逻辑（行选择、截断提示、模糊匹配、换行符保持、图片处理），升级 Pi 时自动跟上，所以选了它；Pi 若在 Operations 之外增加新的本地访问，第 4 节的运行时 spy 测试会失败。

## 4. 改名、描述与零直接调用

| 项 | 做法与结果 |
|---|---|
| 规范名 | 六个工具以 `customTools` 注册；会话选项 `noTools: "builtin"` 加 `excludeTools`（read、bash、powershell、edit、write、grep、find、ls）。被排除的名字连注册都不会发生，扩展无法再激活它们。MCP 与扩展工具不受影响 |
| 描述 | 默认 Profile 的描述、system prompt 中的工具摘要与指引都是 PiArc 自写（`agent-host/src/tools/profile.ts`，ADR-0006 自查：不对应 Claude Code 的任何工具描述原文）。参数 schema 沿用 Pi 的 |
| 模型看到的工具 | mock 请求记录中的 `tools` 恰好是 Read、Write、Edit、Bash、Glob、Grep，描述为默认 Profile 的文本，无 Pi 原生名（A04） |
| 名称映射 | `ToolNameMap` 双向映射模型可见名与规范名，未知名（MCP、扩展工具）原样返回；拒绝重名、非法字符与 Pi 原生名。投影器把 `tool_execution_*` 中的名字映射回规范名。测试 Profile 把六个工具改名为 `read_file` 等：模型只看到新名与测试描述，`item/*` 事件与 Core 收到的 `origin.tool` 仍是 `Read`、`Write`、`Bash`（A05） |
| Core 侧记录 | 一个回合依次调用六个工具，Core 收到：Read → `fs/stat`、`fs/read`；Write → `fs/mkdir`、`fs/write`；Edit → `fs/stat`、`fs/read`、`fs/write`；Bash → `exec/run`；Glob → `fs/stat`、`fs/glob`；Grep → `fs/grep`。每个请求带 `sessionId` 与 `origin { tool, toolCallId }`（A01） |
| 运行时 spy | `packages/testkit/src/io-spy.ts` 经 `NODE_OPTIONS=--import` 预加载进 Agent Host，包装 `fs`、`fs/promises`、`child_process` 的全部函数并 `syncBuiltinESMExports`。场景运行期间：对工作区路径的 `fs` 调用 0 次，`child_process` 调用 0 次（A02）。会话创建时有 1 次：Pi 的 `createAgentSessionRuntime` 用 `existsSync` 检查会话 cwd 存在（`assertSessionCwdExists`），只读元数据，测试单独断言它是唯一的一次（登记 I20） |
| ESLint | `agent-host/src/tools/**` 与 `agent-host/src/harness/**` 禁止静态与动态导入 `fs`、`fs/promises`、`child_process`（含 `node:` 前缀）及 `require`。临时违规时 `npm run lint` 报 5 个错误、退出码 1，撤销后通过（A03） |

唯一经 Agent Host 自己的 `fs` 读取的是 Core 交出的 blob（`agent-host/src/runtime/blobs.ts`，只接受 `<数据目录>/sessions/` 下的路径并核对大小），不在工作区。

## 5. AHP 方法与内容传输

协议类型在 `piarc-protocol` 的 `fs.rs`、`exec.rs`、`tool_call.rs`，20 个新契约都有样本与反例（A09）：

| 方法 | 方向 | 要点 |
|---|---|---|
| `fs/stat` | Agent Host → Core | 跟随符号链接；`detectImage` 时嗅探 JPEG、PNG（非动画）、GIF、WebP、BMP，规则移植自 Pi 的 `utils/mime.ts` |
| `fs/read` | Agent Host → Core | 文本模式：一次最多 1 MiB（`MAX_READ_CHUNK`，即使每字节都要 `\u00XX` 转义也低于 8 MiB 帧上限），不切断 UTF-8 序列，调用方按 `offset` 续读；blob 模式见下 |
| `fs/write` | Agent Host → Core | UTF-8 文本；`append` 让大文本分段写（Agent Host 每段 256 Ki 个 UTF-16 码元，不切断代理对） |
| `fs/mkdir`、`fs/list` | Agent Host → Core | `list` 按名排序，最多 10,000 项 |
| `fs/glob` | Agent Host → Core | fd 的匹配规则：无 `/` 匹配名字，有 `/` 加 `**/` 匹配相对路径，`*` 不跨 `/`，全小写不区分大小写；含隐藏项；`.gitignore`（仓库外也生效）、`.ignore`、`.fdignore`；目录带尾部 `/`；按路径排序 |
| `fs/grep` | Agent Host → Core | ripgrep 的库与规则：`.gitignore` 只在 Git 仓库内生效；`glob` 白名单；目录搜索跳过二进制；Pi 的匹配上限规则（最后一个匹配的尾随上下文照收，再有匹配才算超限）；按文件路径排序 |
| `exec/run` | Agent Host → Core | bash（Unix `/bin/bash`，Windows Git Bash）在会话 cwd 执行；环境为 Core 的白名单环境加请求的 `env` 叠加；输出经通知回传，结束时返回 `exitCode` 或 `signal` 与 `killed` |
| `exec/output` | Core → Agent Host（通知） | `{ requestId, stream, seq, data }`；`seq` 跨 stdout/stderr 从 1 递增；按流解 UTF-8，被切断的序列留到下一块；全部写在 `exec/run` 的响应之前 |
| `exec/kill` | Agent Host → Core | 按 `requestId` 终止直接子进程，返回 `{ killed }`；连接断开时 Core 也终止命令。Bash 的超时与中断都经它实现（Pi 的 `timeout:<秒>`、`aborted` 语义不变） |

新增错误类别：`notFound`（`details.code` 为 `ENOENT`）、`outsideWorkspace`（`details` 含 `path`、`resolved`、`root`）、`ioError`（POSIX 风格 `details.code`）。

**二进制内容（图片）**：按 ADR-0009 第 8 条走引用。`fs/read` 的 blob 模式把整个文件复制到 `<数据目录>/sessions/<会话 id>/blobs/<sha256>`（先写临时名再 rename，同内容复用），响应只带 `{ path, sha256, size }`；Agent Host 读这个文件交给 Pi 的图片处理。文本的单次范围 ≤ 1 MiB，按任务约定内联，不算第 8 条所说的大块数据。Core 侧的图片与 PDF 预处理（第 6.1.3 节）到位后，blob 改存预处理结果，协议不变。

## 6. 路径限定

`piarc_fs::Scope` 持有会话的工作区根与 cwd（都规范化）。请求路径先接到 cwd 上，再按词法去掉 `.`、`..`，然后由操作系统解析存在部分的符号链接；悬空符号链接按目标继续解析（最多 40 跳，超过报 `ELOOP`）；不存在的尾部原样接上。结果必须是根的前缀（按路径组件比较），否则在触碰目标之前返回 `outsideWorkspace`。两边都是规范路径，所以 macOS 的大小写、`/private` 前缀与 Windows 的 `\\?\` 前缀都一致；对外显示时去掉 `\\?\`。

测试（`crates/piarc-core/tests/tool_io.rs`，A07）：对工作区外的文件与目录，分别用绝对路径、`..`、指向外部的符号链接文件与目录，逐个调用 `fs/stat`、`fs/read`（文本与 blob）、`fs/write`（覆盖与追加）、`fs/mkdir`、`fs/list`、`fs/glob`、`fs/grep`，全部返回 `outsideWorkspace`（不可重试，带 `details`）；外部文件内容与修改时间不变，没有创建目录，没有复制 blob。`exec/run` 的 `cwd` 同样受限。检查与操作不是原子的：两者之间换进来的符号链接拦不住，T16 与沙箱收窄这个窗口。

## 7. 行为对照

`crates/piarc-testkit/tests/agent_host/parity.rs`：同一份 17 步的脚本（每步一个工具调用）分别在两个 Agent Host 中运行：一个带 `--pi-native-tools`（Pi 原生工具、本地 I/O、原生名），一个用委托工具（规范名、Core I/O）。两边从同样的工作区开始（含空格与中文的路径、CRLF 文件、`.gitignore`、`node_modules`、一张 PNG），比较 mock 记录里模型收到的每个工具结果（工作区绝对路径替换为 `<WS>`）与运行后的工作区快照。模型用支持图片输入的 `mock-vision`。

| # | 场景 | 工具 | 结果 |
|---|---|---|---|
| 0 | 读整个文件 | Read | 一致 |
| 1 | `offset`/`limit` 分页 | Read | 一致（`[17 more lines in file. Use offset=15 to continue.]`） |
| 2 | 读不存在的文件 | Read | 一致（`ENOENT: no such file or directory, access '<WS>/missing.txt'`） |
| 3 | 读图片 | Read | 一致（同一个 `image/png` 块，base64 相同） |
| 4 | 在新目录写新文件 | Write | 一致 |
| 5 | 覆盖已有文件 | Write | 一致 |
| 6 | 唯一匹配替换 | Edit | 一致 |
| 7 | CRLF 文件替换 | Edit | 一致，CRLF 保持 |
| 8 | 找不到旧文本 | Edit | 一致（`Could not find the exact text in docs/guide.md. ...`，错误） |
| 9 | 成功的命令 | Bash | 一致 |
| 10 | 失败且有输出 | Bash | 一致（`oops ... Command exited with code 3`，错误） |
| 11 | 只在 stderr 输出后失败 | Bash | 一致 |
| 12 | 有匹配并带上下文 | Grep | 一致 |
| 13 | 带 `glob` | Grep | 一致 |
| 14 | 无匹配 | Grep | 一致（`No matches found`） |
| 15 | 有匹配 | Glob | **有意差异**，见下 |
| 16 | 只有被 `.gitignore` 忽略的文件 | Glob | 一致（`No files found matching pattern`） |

运行后两个工作区的 11 个文件逐字节相同。

有意差异：

- **Glob 不列 `node_modules`、`.git`**：Pi 的 find 在使用自定义 `FindOperations.glob` 时，自己传入 `**/node_modules/**`、`**/.git/**` 两个排除模式（`find.ts`），原生 fd 路径没有这一步。差异来自 Pi 的代码，保留；对照测试把它列为预期差异，消失时测试失败。
- **结果顺序**：ripgrep 与 fd 多线程遍历，输出顺序不确定，Pi 不排序；Core 按路径排序。对照把 Glob 结果按行排序后比较，Grep 场景只匹配单个文件。

对照未覆盖、按设计不同的地方：

- **命令环境**：Pi 原生 bash 的子进程继承 Agent Host 的全部环境；委托后命令得到 Core 的白名单环境加 Pi 设置的会话变量（`PI_SESSION_ID`、`PI_MODEL` 等）与 `PATH`，不再看到 Agent Host 自己的 `PI_CODING_AGENT_DIR`、`PI_PACKAGE_DIR` 等内部变量。
- **进程树**：中断与超时只终止 bash 本身（T17 实现进程组与 Job Object）；Pi 原生会杀整棵进程树。
- **设置项**：委托工具不读 Pi 设置中的 `shellPath`、`shellCommandPrefix`、`images.autoResize`（取默认值），登记为 I21，由 T17 与 T21 接上。
- **正则错误文字**：无效的 Grep 正则在原生侧是 ripgrep 的 stderr，委托侧是 `grep-regex` 的错误描述，文字不同。

## 8. AHP 往返耗时

`crates/piarc-testkit/tests/ahp_round_trip.rs`（独立测试二进制，计时期间不跑别的测试）：Core 的监管器启动一个最小 Node 客户端（`packages/testkit/src/ahp-fs-read-client.ts`）代替 Agent Host，握手后依次发 2,200 个 `fs/read`（520 字节的文件），前 200 个预热，计后 2,000 个，每个从写出请求到解析完响应。Core 侧是真实的帧解码、入站分派、阻塞线程池上的 `piarc-fs`。

| 次 | p50 | p95 | p99 | max |
|---|---|---|---|---|
| 1 | 0.144 ms | 0.194 ms | 0.243 ms | 0.437 ms |
| 2 | 0.149 ms | 0.213 ms | 0.260 ms | 0.351 ms |
| 3 | 0.147 ms | 0.218 ms | 0.306 ms | 1.953 ms |

预算 p95 ≤ 5 ms（架构第 11 章），实测约 0.2 ms（A10）。与其他端到端测试并行跑时曾测到 p95 0.78 ms、p99 4.6 ms，所以计时放在独立的测试二进制里。

## 9. 流式输出与取消

`crates/piarc-core/tests/tool_io.rs`（A08）：

- `printf 'first 中\n'; sleep 2; ...`：第一条 `exec/output`（`seq` 1，`stdout`，`first 中\n`）在命令开始后不到 1.5 s 到达，此时命令仍在运行；随后 stderr 与 stdout 各一条（`seq` 2、3），最后响应 `{ exitCode: 4, killed: false }`。请求的 `env` 叠加生效。
- `exec sleep 30`：`exec/kill` 返回 `{ killed: true }`，`exec/run` 随即以 `killed: true` 结束，`kill -0` 确认进程已不存在；再次 `exec/kill` 返回 `{ killed: false }`。
- 连接断开（通知通道关闭）时命令被终止。

## 10. 其他发现

- **工具 I/O 与会话通知共用 stdout**：Core 的事件消费者停住、读取停在投递上时，Agent Host 的 `fs/*` 请求排在通知后面，工具也随之等待。这是有意的背压，不会丢失；但 T06 的背压测试原来在 Core 停读期间等文件写完，现在改为用不存在的工具制造通知洪峰。T14 的事件消费者要持续取走事件（登记 I19）。
- **会话创建时的 cwd 检查**：见第 4 节，登记 I20。
- **嵌套深度（I09）**：`fs/*`、`exec/*` 的参数都是扁平结构；模型给出的工具参数只出现在 `item/*` 通知里，嵌套超过 127 层时该帧会被 Core 拒绝，工具本身照常执行。现有工具 schema 都很浅，可以接受。

## 11. 结论

- macOS：**通过**。六个规范名工具的 I/O 全部经 Core，Agent Host 在场景运行期间零直接调用，对照场景一致（1 项有意差异已列出原因），往返耗时远低于预算。
- 附加条件：read、write、edit 依赖"Pi 只在 Operations 之外按传入的路径做探测"这一事实，grep 是 PiArc 自写（ADR-0020）。Pi 升级时由运行时 spy 测试与对照测试把关。
- Windows：W0 在 Windows 11 本机复跑通过（2026-11-16）：`cargo test -p piarc-testkit --test agent_host` 12 项，修复了两处只在 Windows 出现的测试问题（`canonicalize` 的 `\\?\` 路径让 Node 无法运行脚本；慢读者用例的 Windows 断言，见 S9 报告第 5 节）。CI 的 verify 在更早的 release 夹具失败处停止，下次推送后复核。Git Bash 下的 `exec/run`、路径与换行、与 Pi 原生工具的对照（`parity.rs`，用 `.tools/bin` 的 rg 与 fd）都通过。另修了 `core-io.test.ts`：Pi 在 Windows 上把单字母根目录 `/w` 当作 Git Bash 写法的盘符 `W:\`。
