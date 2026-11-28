# 语音输入（V1–V8）设计增补

- 日期：2026-11-26
- 状态：已确认方向（2026-11-26：基础模型、语音资产预算、麦克风安全取舍、Esc 语义），实施中（PLAN.md"语音输入"章节）
- 决策：[ADR-0094](../../adr/0094-speech-engine-and-base-model.md)（识别引擎、基础模型与运行时按需加载，变更型）、[ADR-0095](../../adr/0095-bundled-speech-asset-budget.md)（内置语音资产单列预算，变更型）、[ADR-0096](../../adr/0096-microphone-access-in-the-security-baseline.md)（麦克风进入安全基线，变更型）、[ADR-0097](../../adr/0097-speech-model-downloads.md)（增强模型下载，补充）
- 输入：`tmp/PiArc-Voice-Dictation-Delivery/PIARC-VOICE-DICTATION-PROMPT.md`（需求原文）与同目录的交互参考 HTML。参考 HTML 只定相对层级与交互，发送按钮、底栏布局与图标沿用 PiArc 现状。
- 参考：sherpa-onnx v2.0.1（Apache-2.0，Rust 安全封装与 C API）；X-ASR-zh-en（Apache-2.0）；Qwen3-ASR-0.6B（Apache-2.0）与 sherpa 的 ONNX 转换（ModelScope `zengshuishui/Qwen3-ASR-onnx`，apache-2.0）；Silero VAD（MIT）；CPAL（Apache-2.0）、Rubato（MIT OR Apache-2.0）。Handy、murmur 只作为产品参考，不读代码。

## 1. 背景与目标

开发者在新会话首页或会话里经常要口述长段任务描述，中英文与技术名词混在一起。PiArc 今天只能键入。目标：

1. composer 的发送按钮左边有麦克风；点击后本机离线实时识别，边说边在输入框里出字，停止后是普通可编辑草稿，用户明确发送才走现有 prompt / steer / followUp。
2. 中文、英文、中英混合技术术语；内置技术词典、用户词典、受信任工作区的依赖名作为热词；可选下载 Qwen3-ASR 做逐段精修。
3. 默认显示入口但不默认监听：应用启动时不加载模型、不采集、不联网。正常安装后断网，首次授权麦克风就能用。
4. 设置页"语音输入"。

## 2. 范围

### 2.1 分期（执行顺序，不缩减范围）

| 期 | 内容 |
|---|---|
| V1 | 资产与运行时：`third-party/speech-assets.lock.json`、`scripts/dev/fetch-speech-assets.mjs`、`crates/piarc-sherpa-sys`（按需加载的 C API 转发层）、deny 与依赖规则、ADR-0094–0097 |
| V2 | `piarc-speech`：采集、下混与重采样、电平、分段协调器、在线识别、状态机、热词、文本规范化、模型清单与校验；真实模型集成测试 |
| V3 | Core 与 NAPI：`piarc_core::dictation`（owner 认领、偏好、工作区词汇、事件路由、生命周期）、协议类型与 L1 样本、`createForTests` 的文件音源 |
| V4 | 主进程：`dictation-ipc.ts`、麦克风授权端口、路由授权、生命周期触发、`openMicrophoneSettings`；Info.plist、entitlement、Seatbelt |
| V5 | 渲染进程：ProseMirror 听写插件与控制器、麦克风按钮、听写条与波形、发送与 Esc 语义、i18n、a11y |
| V6 | 设置页"语音输入"、偏好键 `voiceDictation`、设备枚举与测试麦克风 |
| V7 | 增强：`piarc_web::download`、Qwen3 模型管理（下载、取消、重试、启用、删除）、逐段精修与保守合并 |
| V8 | 打包与布局检查、性能探针与预算、质量评测、L4 与截图、文档与收尾 |

### 2.2 明确不做

语音对话、TTS、唤醒词、系统全局听写、后台监听、云端识别、默认的 LLM 润色、语音附件、录音历史、GPU 推理、Python 或 Docker 依赖、可配置模型路径。渲染进程拿不到 PCM，`media` 权限继续拒绝。

### 2.3 与需求原文的偏离（已确认）

| 原文 | 本设计 | 依据 |
|---|---|---|
| 基础模型 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`（三份 INT8）+ CT-Transformer 标点 | `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`，自带标点与大小写，不要 CT-Transformer | PoC（附录 A）：同语料中文 CER 4.5% 对 39.9%、英文 WER 4.9% 对 51.2%、体积 169 MB 对 278 MB；CT-Transformer 上游模型许可含非标准条款。用户 2026-11-26 确认，ADR-0094 |
| 增量 ≤ 250/300 MiB，"现有更严格约束优先" | 第 11 章非语音预算不变，另起"内置语音资产"一行 | 现有安装包与安装后预算余量 24 MB 与 3 MB，内置任何模型都超出。用户确认，ADR-0095 |
| partial 更新 100–250 ms | X-ASR 480 ms 分块，partial 每 480 ms 更新一次；首个 partial 预算不变 | 模型分块粒度，不是人为延迟；160 ms 版本在同语料上英文 WER 19.5%。ADR-0094 记录 |
| Esc 取消听写 | Esc 停止听写并保留文字；只有 × 是取消（可一步撤销） | 用户 2026-11-26 决定 |
| 窗口关闭、应用退出时尽力保留到 owner 草稿；验证本地草稿自动保存 | 同一窗口内切会话与 composer 卸载时保留；窗口关闭与退出直接结束 | 草稿只在渲染进程内存（`store/app-store.ts:35-45`），窗口关闭后草稿本来就没有 |
| Qwen 精修 P95 ≤ 1.5 s | 目标保留；PoC 在 2 线程下 p95 3.1 s，按实测调线程后报告，不达标标为发布阻塞，增强默认关闭 | 需求 11.2 节的处理规则 |

### 2.4 实现与本设计的差异（2026-11-26 交付时）

实现以代码为准的地方，以及交付时还没做到的地方：

| 条目 | 实现 | 说明 |
|---|---|---|
| 4.6、4.8 `speechTestMic` | 测试麦克风走 `dictationStart`，`test: true`（Core 只发电平，不加载识别模型），没有单独的命令 | 少一条 IPC；真实输入与可见窗口的要求照样适用 |
| 4.4 `SpeechEvent::Download` | 下载进度并进 `core/speech` 的 `SpeechModels`（`receivedBytes`、`state`） | 设置页只订阅一个事件 |
| 4.6 `speechModelAction` 的 `enable`、`disable` | 没有；模式经偏好 `voiceDictation.mode` 切换 | 下载完成后在设置页自动切到增强（"下载并启用"） |
| 4.5 `core/speech` 广播 | `try_send`，队列满时这一次广播会丢 | 设置页打开与每次操作后都会重新请求 `speechModels`，不会停在旧状态 |
| 3.6.1 工作区词汇的读取 | 用 `std::fs`：先规范化路径、确认仍在工作区内，再读文件，没有经 `piarc_fs` 目录句柄 | 规范化与读取之间被换成链接时，可能读到工作区外的文件；读到的内容只用作热词（包名），不显示、不记录 |
| V-5.2 录音中系统授权被撤销 | 主进程不单独监听；采集流出错时按设备丢失结束并保留文字 | 未实测 |
| V-8.2 基础模型"修复" | 只有"重新校验"；校验不通过时提示重新安装 PiArc | 内置模型没有逐文件的下载源 |
| 5.3 L4 | 只落了 E02、E05、E09（拒绝）、E10 的主要部分与 a11y 设置页；E01、E03、E04、E06、E07、E08、E11、E14、V-2.8 的缩放与窄窗没有 L4 用例 | 对应逻辑有 Vitest 或 Rust 单测的部分见交付说明 |

## 3. 需求与验收标准

可观察点：`data-testid`（写作 `#id`）、主进程测试钩子 `dictation()`（Core 的听写状态：`state`、`owner`、`sessionId`、`engineLoaded`、`captureOpen`、`overflow`）、mock provider 收到的请求、L4 的 net log、`phys_footprint`。L4 的音频来自开发构建的文件音源（3.9）。

### 3.1 入口与默认状态

- V-1.1 Home 与 Conversation 的 composer 在发送按钮左边有 `#composer-mic`（`IconButton`，`size="sm"`，Lucide `Mic`，可访问名称与提示"语音输入 / Voice input"）。偏好 `voiceDictation.enabled` 为 false 时不渲染；默认 true，旧设置文件没有这个键时按 true。
- V-1.2 启动后未点击麦克风：`dictation()` 显示 `engineLoaded: false`、`captureOpen: false`；net log 没有任何模型下载主机；主进程 `phys_footprint` 中位数相对 `e2ed327f` 的增量 ≤ 15 MiB（同机各 10 次）。
- V-1.3 `disabled` 的 composer（Home 等待信任等）麦克风禁用；只读与忙碌限制沿用 composer 现状。

### 3.2 状态与界面

- V-2.1 状态机 `idle → preparing → recording → finalizing → completed → idle`，任何活跃态可到 `cancelled` 或 `error`；`error` 可重试。Core 是状态的唯一来源，渲染进程按 `{sessionId, sequence}` 跟随。
- V-2.2 点击到界面有反应 ≤ 100 ms（按钮进入 preparing 样式）。preparing 超过 300 ms 时听写条显示"正在准备本地语音模型…"；首次的系统授权框不计时。
- V-2.3 听写期间（含错误与提示）听写条 `#composer-dictation` 占据 composer 的操作行（网格 `voice` 区域，从 `+` 到模型控件），这些控件暂时让位，听写结束即恢复；麦克风位与发送位不动。左端取消 `#dictation-cancel`（×，与 `+` 同尺寸、同位置），中间是真实波形 Canvas（`aria-hidden`）占满余下宽度，录音中右侧紧挨停止键的是红点与 `m:ss`（"录音中 / Listening"只给读屏）；准备中、正在完成转录、错误与操作、提示以文字出现在波形之前或替代波形。麦克风位变为停止听写 `#dictation-stop`（标签"停止听写"，Lucide `Square` 线框图标，中性淡底，`aria-pressed=true`），与 Agent 的停止（实心方块）在标签、提示、形状上都不同。
- V-2.4 波形用 Core 送来的真实 envelope（每 40 ms 一个 `level` 事件，最多 8 个桶），每 80 ms 音频折成一根柱（取最响的桶），最新的在右侧、按墙钟在事件之间平滑左移（至多超前一个窗口）；分贝刻度，静音是一排淡色圆点，左端渐隐；rAF 绘制，`prefers-reduced-motion` 时只按整根柱移动、每 250 ms 重绘一次。录音 5 s 内 Composer 组件渲染次数 ≤ 状态变化次数 + 2。
- V-2.5 文字出现在输入框内：未稳定的 partial 是光标处的 widget decoration（`.dictation-partial`，次要文字色、虚线下划），不改文档；端点后成为受跟踪的已确认片段写进文档。有 partial 时不显示占位文字。
- V-2.6 完成后回到普通 composer，保留光标、选区、附件；无成功提示。
- V-2.7 错误与占用：听写条内联显示原因与操作（重试、打开设置、打开系统麦克风设置、修复模型、切到正在录音的窗口），保留已确认文字与其他草稿。
- V-2.8 窄窗口（composer 宽 320 px）与 200% 缩放下按钮包围盒不越界、不裁剪焦点环；两种主题、两种密度对比度达标（axe）。

### 3.3 文本所有权（ProseMirror）

- V-3.1 开始时在 `selection.to` 折叠插入；不覆盖选中文字；mention、命令芯片、片段与附件不变。
- V-3.2 同一片段的 partial 是快照：新的替换旧的；乱序、重复、旧会话、更小 segmentId 的事件忽略。
- V-3.3 `provisional`（端点后，未启用增强时直接是 `final`）以一个事务插入，`closeHistory` 后单独成为一个撤销步，不与 500 ms 内的用户键入合并；partial 永远不进 history。
- V-3.4 用户改动了某片段的范围（键入、删除、粘贴、撤销）后，该片段被"接管"：之后的 final 与精修对文档的改动为 0。
- V-3.5 用户在片段之外编辑：片段范围随映射移动，后续替换位置正确。锚点被删除或文档被整体替换（`fill`、外部草稿）时安全停止，partial 不迁移。
- V-3.6 ASR 事务不改用户的选区、不调用 `focus`、不打开 mention 或 `/` 面板；识别出的 `@foo`、`/clear` 是纯文本。
- V-3.7 输入法合成期间（`view.composing`）不派发 ASR 事务与 decoration 更新，合成结束后依次应用。
- V-3.8 取消：一个事务删除仍归听写所有、未被接管的片段与 partial，可一次 Mod+Z 恢复；被接管的片段保留并提示。
- V-3.9 同一窗口内 composer 卸载（切会话、关 Home）时：当前 partial 作为一个片段写进文档，草稿照常保存（`EditorDraft.doc`），然后停止听写；之后到达的事件忽略。

### 3.4 停止、发送、Esc

- V-4.1 停止（■ 或 Esc）只结束听写：采集立即关闭，尾帧补静音、`input_finished`、解码剩余音频，P95 ≤ 500 ms 内最后一段可编辑；不发送。
- V-4.2 听写在 preparing、recording、finalizing 时，发送位一律是"发送 / 插话"，不切成 Agent 停止；文档、partial、附件任一非空即可点。Esc 在听写期间只停止听写，不中止 Agent；听写结束后 Esc 恢复原语义（mention、命令面板、输入法优先级不变）。
- V-4.3 录音中点发送（或 Enter）= 明确发送：冻结所有权、停止并等待基础结果（上限 3 s，未完成的精修丢弃，不替换已显示的文字），然后从当前编辑器状态取一次快照走现有提交管线。运行中按钮与 Enter 是 steer，Mod+Enter 是 followUp。finalizing 期间重复点击、Enter、Mod+Enter 不重复发送；mock provider 恰好收到 1 次。
- V-4.4 preparing 时点发送：取消听写（还没有音频），照常发送已有草稿。
- V-4.5 权限或识别错误、用户在等待期间切换草稿或取消、等待超时且没有文字、原稿为空时，不自动发送，听写条说明原因。

### 3.5 会话与生命周期

- V-5.1 全应用一个录音会话。`dictationStart` 原子认领 `{windowId, composer, sessionId}`；其他窗口或 composer 点击时得到 `busy`，听写条显示"另一个窗口正在使用语音输入"与"切到那个窗口"。
- V-5.2 停止采集的触发：owner 窗口关闭、重载或渲染进程崩溃；owner composer 卸载（V-3.9）；窗口最小化；系统休眠或锁屏；设备移除或采集出错；系统授权被撤销；偏好关闭；打开设置模态（ADR-0074：先停止并保留）；应用退出。失焦但可见时继续。
- V-5.3 单次录音满 10 分钟自动停止并保留结果，提示可以继续下一段；连续 30 s 没有语音（VAD）自动停止，已有草稿不变。时长按送入的音频计。
- V-5.4 引擎空闲 60 s（无录音、无测试麦克风）后释放模型与引擎线程；偏好关闭与应用退出立即释放。采集设备在停止、取消、错误时立即关闭。

### 3.6 识别质量与热词

- V-6.1 内置技术词典（PiArc、Claude Code、Codex、Qwen、GLM、AgentScope、Spring Boot、MyBatis、PostgreSQL、Elasticsearch、TypeScript、React、Vue、NAPI-RS、Electron、Rust、MCP、Harness、Redis、Kubernetes 等）默认生效；用户词典；受信任工作区的依赖名（3.6.1）。合并去重后最多 128 条、每条 ≤ 64 UTF-8 字节；含控制字符、双向控制字符、`/`、`:`、换行或不能被模型的 BPE 编码的词条拒绝。每次开始时取快照，录音中不变。
- V-6.2 规范化只做三件事，都有纯函数测试：已知词条的大小写（`redis` → `Redis`，按词边界）、被拆开的已知缩写（`M C P` → `MCP`，拼起来是词典里的词才合并）、中英文之间的空格。不做全局替换、翻译、改写；数字、否定词、版本、路径不碰。
- V-6.3 自动标点关闭时去掉基础结果里的句读标点（模型自带的标点）；精修模型自己的标点不承诺去掉（设置页说明）。
- V-6.4 静音、纯噪声不出字：一个片段内 VAD 没有检测到语音时丢弃该片段的文字。
- V-6.5 质量门槛（需求 11.2 节）：干净中文 CER ≤ 12%、英文 WER ≤ 15%、中英技术混合 MER ≤ 18%、内置与用户词典术语召回 ≥ 85%；否定词、数字、版本、路径的错误单独统计。未达标的如实报告并标发布阻塞，不改口径。

#### 3.6.1 工作区词汇

只在偏好开启且当前工作区受信任（`piarc_config::project_trust`）时读；只读工作区根目录的 `package.json`（`name`、`dependencies`、`devDependencies` 的键）与 `Cargo.toml`（`package.name`、`dependencies` 与 `dev-dependencies` 的键）；经 `piarc_fs` 的目录句柄读取，链接出项目的不读，每个文件 ≤ 256 KiB，最多 64 条；拆分 `@scope/name` 与 `-`、`_` 连接的名字只保留整名。词表不进日志。

### 3.7 精修（增强模式）

- V-7.1 增强默认关闭，不内置、不自动下载。设置页"下载并启用"先显示下载大小（982 MB 级，以清单计算）、安装后占用、内存影响（峰值约 2 GB）。
- V-7.2 下载只在用户确认后进行；单飞；进度在 `core/speech` 广播；关闭设置不取消；取消真正停止并清理暂存；失败可重试；完成并逐文件校验后原子启用。
- V-7.3 每段 PCM（含 300 ms 前导、500 ms 拖尾，≤ 20 s）在端点后交给精修线程；队列最多 2 段，积压时新段直接用基础结果；每段 3 s 截止，超时、失败、OOM 用基础结果并显示轻提示；final 严格按 segmentId 顺序提交。
- V-7.4 保守合并：基础结果中的数字、否定词、版本号、路径、词典术语在精修结果里都在，且两者规范化后的编辑距离不超过较长者的 50% 时才用精修结果；否则保留基础结果。
- V-7.5 删除增强模型：使用中先切回基础并释放引用，用户在主进程原生确认后删除；不能删除正在使用的模型。基础模型不可删除，只能"重新校验 / 修复"。

### 3.8 设置页"语音输入"

- V-8.1 `registerSettingsPage({ id: 'voice', … })`，排在"通用"之后（order 2）；设置搜索、深链 `#/settings/voice`、焦点恢复、托管锁定都可用。
- V-8.2 控件：启用（开关）；麦克风（系统默认 + 枚举的设备，刷新；失效时回退默认并提示）；测试麦克风（与正式录音互斥，离开页面即停，只显示电平）；识别模式（基础 / 高质量，高质量未安装时显示大小、"下载并启用"、进度、取消、重试、删除）；自动标点；技术术语增强；工作区词汇增强；自定义词典（添加、删除、去重、校验失败说明）；模型资源（基础模型版本、状态、大小、"重新校验"）；隐私说明。
- V-8.3 偏好跨窗口同步（`preferences` 应用事件），写入失败回滚并显示原因。

### 3.9 安全与隐私

- V-9.1 `dictationStart`、测试麦克风、下载要求发起窗口 5 秒内有真实输入（`InputGuard.requireInput`）；窗口不可见或最小化时拒绝开始。
- V-9.2 听写事件只经 `dictation/<webContentsId>` 路由；只有该窗口能订阅（路由授权器）；其他窗口订阅被拒。
- V-9.3 设备 id 与模型 id 只接受 Core 枚举出的值；参数一律当作 `unknown` 校验；错误只带 kind 与 code，不带路径、URL、文本或音频。
- V-9.4 PCM 只在进程内有界缓冲，不落盘；识别文本与词表不进日志、telemetry、诊断包；识别器 `debug=false`。
- V-9.5 开发构建的文件音源（`PIARC_TEST_SPEECH_SOURCE`）只存在于 `createForTests`，位于授权闸门之后；发布构建没有该导出（`check-app-layout --flavor release` 按标记字符串扫描 `.node`）。
- V-9.6 macOS：Info.plist 有 `NSMicrophoneUsageDescription`；只有主程序带 `com.apple.security.device.audio-input`；Agent Host 的 Seatbelt 配置与 Bash 沙箱配置拒绝麦克风与摄像头（ADR-0096）。

### 3.10 包体与性能

| 指标 | 预算 | 说明 |
|---|---|---|
| 内置语音资产（安装后，`Resources/speech/`） | ≤ 230 MB | ADR-0095；含运行时库 |
| 内置语音资产对安装包的增量 | ≤ 190 MB | 同一提交有无语音资产两次出包之差 |
| 非语音安装包、安装后体积 | 不变（≤ 200 / 450 MB） | 探针扣除 `Resources/speech/` 后判定 |
| 预热后首个 partial（首个语音帧到上屏） | P95 ≤ 800 ms | 按实时节奏注入，n ≥ 60 |
| 冷加载到可采集 | P95 ≤ 2 s | 强制卸载后测，n ≥ 20 |
| 停止到最终可编辑 | P95 ≤ 500 ms | 基础模式 |
| 精修 2–5 s 片段 | P95 ≤ 1.5 s（目标） | 已加载 |
| 活跃基础额外物理占用 | ≤ 600 MiB | `phys_footprint` |
| 活跃增强额外物理占用 | ≤ 2.5 GiB | 同上 |
| 空闲非语音主进程增量 | ≤ 15 MiB | V-1.2 |
| 实时率 | RTF P95 < 0.5 | 2 线程 |

## 4. 设计

### 4.1 总体

```text
Composer (ProseMirror) ── dictation plugin + controller ── MicButton / DictationStrip (Canvas)
   │ window.piarc.dictation*            ▲ subscribeEvents('dictation/<webContentsId>')
Electron main: dictation-ipc.ts (validate, requireInput, mic permission, owner window, lifecycle)
   │ NAPI (queue + JsDeferred)          ▲ event batches (route dictation/<id>, core/speech)
piarc-core::dictation (owner claim, prefs, vocabulary, routes, downloads via piarc_web::download)
   │
piarc-speech: engine thread ── capture (CPAL → SPSC ring) ── audio (downmix, rubato 16 kHz, levels)
               ├ coordinator (online endpoint + Silero VAD) ── online X-ASR (sherpa-onnx)
               ├ refine thread (Qwen3 OfflineRecognizer, queue ≤ 2, 3 s deadline)
               └ models (manifests, verification) · vocabulary · transcript (pure functions)
piarc-sherpa-sys (patch of sherpa-onnx-sys): libloading → Resources/speech/runtime/{onnxruntime, sherpa-onnx-c-api}
```

### 4.2 原生运行时与 `piarc-sherpa-sys`（ADR-0094）

- 安全封装用上游 `sherpa-onnx = "=2.0.1"`，不改。它依赖的 `sherpa-onnx-sys` 经根 `Cargo.toml` 的 `[patch.crates-io]` 换成 `crates/piarc-sherpa-sys`（包名仍是 `sherpa-onnx-sys`，版本 2.0.1）：结构体与常量照抄上游 2.0.1（Apache-2.0，保留 LICENSE 与来源说明），函数由 `scripts/dev/gen-sherpa-sys.mjs` 从上游声明生成为同名 `pub unsafe fn`，经 `libloading` 转发到运行时加载的函数表；没有 build.rs，不下载、不链接。表未加载时创建类函数返回空指针、其余返回零值，安全封装因此得到 `None`。
- `piarc_sherpa_sys::load(dir)` 按绝对路径加载：macOS 先 `libonnxruntime.dylib` 再 `libsherpa-onnx-c-api.dylib`（后者 `@rpath` 指向 `@loader_path`）；Windows 先 `onnxruntime.dll` 再 `sherpa-onnx-c-api.dll`，用 `LOAD_WITH_ALTERED_SEARCH_PATH`，不按名字搜索（避免 System32 里的同名库）。加载一次后不卸载（ONNX Runtime 不支持安全卸载），模型与会话照常释放。
- 运行时取官方 `*-shared-no-tts-lib`（Windows 取 `shared-MD-Release-no-tts-lib`），四个目标锁在 `third-party/speech-assets.lock.json`。no-tts 版本不含 espeak-ng（GPL-3.0），C API 的 TTS 函数是桩。
- 依赖规则：`piarc-sherpa-sys` 在 sys 层；`piarc-speech → sherpa-onnx(外部) → piarc-sherpa-sys` 登记例外；`unsafe` 白名单加这个 crate（coding-standards 2.8、根 `Cargo.toml` 注释）。

### 4.3 `piarc-speech`（功能 crate）

依赖：`sherpa-onnx`、`cpal =0.18.2`、`rubato =5.1.0`、`rtrb`（SPSC）、`sha2`、`serde`、`thiserror`、`piarc-protocol`。不依赖其他功能 crate。

| 模块 | 职责 |
|---|---|
| `engine` | 专用线程（`std::thread`，不在 tokio 或 Electron 主线程）：持有运行时、在线识别器、VAD、CPAL `Stream`；命令通道 `Start/Stop/Cancel/Shutdown`；空闲 TTL；sherpa 的对象不是 `Send`，只在这个线程创建与使用 |
| `capture` | `AudioSource` trait（`Cpal`、测试的 `WavSource`）；CPAL 回调只把样本写进有界 `rtrb`（约 2 s）并原子计数溢出；设备枚举返回不透明 id（设备名的稳定哈希）与显示名 |
| `audio` | 下混（I16/U16/F32，N 声道均值，clamp）、`rubato` 连续重采样到 16 kHz（每会话一个重采样器，停止时 flush）、20 ms 帧、`level`（RMS、peak、8 桶 envelope，40 ms 一个） |
| `coordinator` | 唯一分段协调器：同一 16 kHz 时间线同时送在线识别与 Silero VAD；端点只由在线识别的 `is_endpoint` 决定（rule1 2.4 s、rule2 0.8 s、rule3 20 s）；VAD 给出"片段内有无语音"、30 s 无语音、片段 PCM 边界（前导 300 ms、拖尾 500 ms）；停止时补 1.2 s 静音并 `input_finished` |
| `session` | 状态机与事件序号；10 分钟与 30 s 上限；send 模式的停止（丢弃待精修） |
| `refine` | 精修线程：`OfflineRecognizer`（Qwen3，`Send + Sync`），队列 2，截止 3 s，按 segmentId 排序提交 |
| `vocabulary` | 内置词典、合并、去重、排序、上限、校验（字符必须出现在 BPE 词表里），生成 `/` 分隔的热词串（小写） |
| `transcript` | 规范化与保守合并（纯函数）；去标点 |
| `models` | 清单（编进二进制）、布局、逐文件 SHA-256 校验、状态（`ready`、`missing`、`corrupt`、`installing`），增强模型的暂存目录与原子启用 |

识别参数：X-ASR 480 ms，`modeling_unit = "bpe"`，`bpe_vocab` 为构建期由 `bpe.model` 导出的 `bpe.vocab`；热词非空时 `modified_beam_search`、`max_active_paths 4`、`hotwords_score 1.5`，否则 `greedy_search`；ONNX Runtime 2 线程；`debug = false`。

事件经 `DictationSink` trait 交给 Core：`level` 用不阻塞的投递（队列满即丢并计数），文本、状态、终态用阻塞投递（引擎线程不是运行时线程）。

### 4.4 协议（`piarc-protocol::dictation`）

```rust
// 事件：路由 dictation/<webContentsId>（只给 owner 窗口）
enum DictationEvent {
  State { session_id, sequence, state: Preparing|Recording|Finalizing|Completed|Cancelled|Error, code: Option<String>, recoverable: bool },
  Level { session_id, sequence, audio_ms: u64, rms: f32, peak: f32, envelope: Vec<f32> /* ≤ 8 */ },
  Text  { session_id, sequence, segment_id: u32, revision: u32, kind: Partial|Final, text: String /* ≤ 4 KiB */, refined: bool },
  Notice{ session_id, sequence, code: String },
}
// 事件：路由 core/speech（广播，只有模型与设备状态，不含文本）
enum SpeechEvent { Models { models: Vec<ModelStatus> }, Download { model_id, received, total, state } }
```

`gen:protocol` 生成 TS，`tests/contracts/dictation/` 与 `speech/` 有样本与反例。`Final` 在未启用增强时于端点后立即发出；启用时先发 `Final{refined:false}`（provisional），精修完成再发同一 segmentId、更高 revision 的 `Final{refined:true}`。

### 4.5 Core（`piarc_core::dictation`）

- `DictationService`（Core 一份）：`start(owner, request)` 原子认领（`Mutex<Option<Owner>>`），读偏好（`client_settings`），工作区受信任时收集词汇（3.6.1），把 `SessionConfig` 交给引擎；`stop(session, mode)`、`cancel`、`status`、`devices`、`test_mic(owner, on)`、`release(window)`（主进程在窗口关闭、重载时调用）、`set_enabled(false)` 立即停止并释放。
- 资源目录：`CoreOptions.speechDir`（主进程给：打包为 `process.resourcesPath/speech`，源码树为 `target/speech-assets/<platform>-<arch>`）；缺失时模型状态为 `missing`，不影响 Core 启动。增强模型在 `DataDirs.cache()/speech/`。
- 下载：`piarc_web::download`（4.7）+ `piarc_speech::models` 的暂存与启用；进度与状态发 `core/speech`。
- 有序关闭的第 1 步先停听写并 join 引擎与精修线程。
- 偏好：`client_settings::CLIENT_KEYS` 加 `voiceDictation`，schema 加字段，`strip_project` 去掉项目层；诊断包把 `voiceDictation.customTerms` 换成计数。
- `createForTests`：`PIARC_TEST_SPEECH_SOURCE=<wav>` 让 `capture` 用 `WavSource`（按设备原生格式 48 kHz 立体声 f32、随机回调尺寸、按绝对时刻推送）；测试钩子可 `dictationInject`（断开、强制卸载）。

### 4.6 NAPI（`crates/piarc-napi/src/dictation.rs`）

`dictationStart(requestJson) → Promise<string>`、`dictationStop(sessionId, mode)`、`dictationCancel(sessionId)`、`dictationStatus()`、`dictationRelease(windowId)`、`speechDevices()`、`speechModels()`、`speechModelAction(modelId, op)`（`download`、`cancel`、`enable`、`disable`、`delete`、`verify`）、`speechTestMic(windowId, on)`。全部按 `queue` + `JsDeferred`，同步方法只校验与入队。

### 4.7 下载器（`piarc_web::download`，ADR-0097）

流式写暂存文件；只用 HTTPS；每一跳（≤ 5）主机都在本次请求的白名单里（ModelScope：`modelscope.cn`、`cdn-lfs-cn-1.modelscope.cn` 等以实测为准）；直连时做 SSRF 检查；代理取 Core 的生效值以 `CONNECT` 建隧道；字节数超过清单 size 立即中止；边写边算 SHA-256；已有暂存时带 `Range` 续传，服务器不支持则从头；可取消。Qwen3 按文件从 ModelScope 锁定 revision 下载（与 sherpa 归档成员的哈希逐个相同，附录 A），运行时不解包归档。

### 4.8 主进程（`apps/desktop/src/main/core/dictation-ipc.ts`）

- 通道：`dictationStart({composer, sessionId?})`、`dictationStop(sessionId, mode)`、`dictationCancel`、`dictationStatus()`（含本窗口的路由键）、`speechDevices()`、`speechModels()`、`speechModelAction(modelId, op)`（删除先原生确认）、`speechTestMic(on)`、`openMicrophoneSettings()`、`focusDictationOwner()`。
- 授权端口 `MicrophonePermission`：macOS `systemPreferences.getMediaAccessStatus('microphone')`，`not-determined` 时 `askForMediaAccess`（只在用户点击后）；`denied`/`restricted` 返回 `microphoneDenied`，不再弹框；Windows 读 `getMediaAccessStatus`（隐私开关）。L4 用 `app.evaluate` 换成替身。
- 生命周期：`BrowserWindow` 的 `closed`、`minimize`，`webContents` 的 `did-start-navigation`（重载）、`render-process-gone`，`powerMonitor` 的 `suspend`、`lock-screen` → `dictationRelease` 或 `stop`。
- 路由授权器：`dictation/<n>` 只给 `webContents.id === n` 的窗口（`event-ipc.ts` 的授权与 `TerminalOwners.mayObserve` 同一处组合）。
- `openMicrophoneSettings`：macOS `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`，Windows `ms-settings:privacy-microphone`，固定字符串，不接受页面参数。

### 4.9 渲染进程

- `composer/dictation/plugin.ts`：插件状态 `{anchor, segments: [{id, from, to, revision, refined, touched}], partial}`；用 `tr.mapping` 映射；用户事务（无 `dictation` meta）与片段范围相交即 `touched`；decoration 是 anchor 处的 widget。
- `composer/dictation/controller.ts`：订阅本窗口路由，按 `sessionId` 与 `sequence` 过滤；把事件变成插件事务（合成中排队）；`stop`、`cancel`、`sendAfterStop`（一次性闩锁）；卸载时提交 partial 再停止。
- `composer/dictation/MicButton.tsx`、`DictationStrip.tsx`、`waveform.ts`（Canvas 在 rAF 里画，数据在模块内环形缓冲，不进 React 状态）。
- `Composer.tsx`：网格 `'shelf shelf shelf shelf' 'voice voice voice voice' 'add editor mic send'`；`stopping` 在听写活跃时为假；Esc 在听写活跃时停止听写（在 mention 与命令面板之后、`keys` 之前）；发送位在听写中走 `sendAfterStop`；`empty` 判断计入 partial。
- 设置页 `settings/VoicePage.tsx`；偏好 `shared/preferences.ts` 的 `voiceDictation`：

```ts
interface VoiceDictationPreferences {
  enabled: boolean;              // true
  device: string | null;         // null = 系统默认；不透明 id
  mode: 'basic' | 'enhanced';    // 'basic'
  punctuation: boolean;          // true
  techTerms: boolean;            // true
  workspaceTerms: boolean;       // true
  customTerms: readonly string[];// []，≤ 64 条，每条 ≤ 64 字节
}
```

- i18n：`dictation.*`、`settings.voice.*` 两份目录；a11y：`state:dictation-recording`、`state:dictation-error`、`settings:voice` 登记并接 T43 旅程；`aria-live="polite"` 只播报状态变化与每个 final 片段（不播 partial）。
- 快捷键：`COMMANDS` 加 `composer.dictation`（默认不绑定），`Shell.tsx` 经请求总线交给当前会话的 composer。

### 4.10 打包

- `scripts/dev/fetch-speech-assets.mjs`：按 `third-party/speech-assets.lock.json` 下载（缓存 `.tools/cache/speech/`，size + SHA-256），用系统 `tar` 解出清单列出的成员，导出 `bpe.vocab`（Node 实现，结果哈希也在锁文件里），布局到 `target/speech-assets/<platform>-<arch>/{models/x-asr-zh-en-480ms-int8/, models/silero-vad/, runtime/}`。`package:desktop` 与 `build:core` 之后自动运行；离线时用缓存。
- `packaging/speech-layout.mjs` 导出布局；`postPackage` 复制到 `Resources/speech/`，Mach-O 由 `signResourcesAndBundle` 签名；`check-app-layout.mjs` 核对文件清单与哈希、主程序 entitlement、Helper 与 node 没有 `audio-input`、发布构建没有文件音源标记。
- `forge.config.ts` 的 `extendInfo` 加 `NSMicrophoneUsageDescription`；`entitlements.mac.plist` 拆出主程序用的一份（加 `device.audio-input`）。
- NOTICES 与 `third-party/sources.json` 记录 sherpa-onnx、ONNX Runtime、X-ASR、Silero VAD、Qwen3 转换的许可。

### 4.11 迁移与兼容

偏好新键缺省为默认值（`preferencesFrom`）；没有数据库迁移；模型状态由文件系统推导。旧版本升级后入口默认可见。

### 4.12 文档

架构 2.76：第 4 章 ADR 表、7.1 节加 `piarc-speech` 与 `piarc-sherpa-sys`、8.1 节主进程与渲染进程模块、10.1 节 THR-18（麦克风与听写内容）、THR-19（语音模型被替换）、THR-14 措辞、10.3 节 entitlement 一句、11 章"内置语音资产"一行；`docs/security/egress.md`；S10 报告；根与各级 AGENTS.md 的命令和不变量。

## 5. 测试计划

### 5.1 Rust

- `cargo test -p piarc-speech`：重采样跨回调尺寸连续（与整段一次重采样逐样本差 ≤ 1e-4）、下混各格式、环形缓冲溢出计数不阻塞、协调器的前导与 20 s 切分与静音不出段、尾帧补静音顺序、状态机全表（重入只产生一个终态）、10 分钟与 30 s 上限按音频时钟、引擎线程退出与 TTL 卸载、错误不含路径、热词规范化与上限与拒绝、保守合并表、精修乱序按序提交与截止降级、事件有界与序号单调、规范化纯函数（中文、emoji、UTF-16、代码片段、数字、否定、大小写）。
- `PIARC_REQUIRE_SPEECH_MODELS=1 cargo test -p piarc-speech --test real_model`：EOF 之前出 partial（中、英、混合）、末字不吞、长句跨段无重复、静音与噪声不出字、热词开关对比、两次解码一致；`--test real_model_refine`（Qwen3，nightly）：精修与截止降级。不设变量时打印 NOT RUN（不算通过）。
- `cargo test -p piarc-web download`：本地 HTTPS 夹具（测试 CA、过期证书、SAN 不符）、本地 CONNECT 代理与 407、哈希不符、截断续传、忽略 Range、超出 size、白名单外重定向与 `http://`、跳数、取消、并发单飞。
- `cargo test -p piarc-core --lib dictation::`：并发 start 只有一个 owner、错误 owner 的 stop/cancel、事件只在 `dictation/<id>`、工作区词汇只在受信任项目且不跟随出项目的链接、偏好白名单与 `strip_project`、刚启动无引擎线程、结束后无音频文件且日志里没有识别文字（THR-18 金丝雀）。
- `cargo test -p piarc-sandbox --test devices`：Agent Host 与 Bash 沙箱两份 Seatbelt 配置在真实 `sandbox-exec` 下拒绝 `device-microphone`、`device-camera`（`sandbox_check` 询问运行中的进程，THR-18）。
- `cargo test -p piarc-sherpa-sys`：未加载时创建函数返回空、加载失败给出 kind。

### 5.2 Vitest

`composer/dictation/*.test.ts`（真实 `EditorState` 与 `EditorView`）：V-3.1–V-3.9、V-4.2–V-4.5 的逐条用例；`dictation-ipc.test.ts`（参数校验、owner、授权端口、生命周期）；`router` 与授权器（非 owner 订阅被拒）；`preferences.test.ts` 的 `voiceDictation`；设置注册与搜索。

### 5.3 L4（`PIARC_EVIDENCE_TASK=voice npx playwright test -c apps/desktop/playwright.config.ts voice- --project dev`，packaged 同跑）

E01 默认可见与关闭隐藏、启动不加载不联网；E02 文件音源中文 WAV：preparing → recording → partial（序列化不变）→ 停止后可编辑、mock 收到 0 个请求；E03 录音中带附件与 mention 发送并连点：mock 恰好 1 个请求；E04 Agent 运行中、文档为空开始录音后 Enter 与 Mod+Enter：发送位始终是发送，1 次 steer、1 次 followUp，回合不中止；E05 录音中别处键入后点 ×：键入保留、听写撤销、Mod+Z 恢复；E06 CDP 输入法合成中推 partial；E07 两个窗口：B 显示占用、B 订阅被拒；E08 每种生命周期触发；E09 授权替身 denied/restricted/not-determined；E10 设置页全部控件；E11 本地 HTTPS 镜像 + 测试清单的下载、取消、重试、启用、删除；E12 a11y（axe 亮暗）、键盘、减少动效、200% 缩放、窄窗口、中英文截图；E13 t45 畸形参数与没有真实输入的 start；E14 渲染次数与 level 频率。

### 5.4 打包与性能、质量

- `node scripts/ci/check-app-layout.mjs --flavor development|release`：语音资产清单与哈希、entitlement 分层、发布构建无文件音源；Windows 交叉 clippy 断网通过。
- `scripts/perf/probe-voice.mjs`：首 partial、冷加载、停止到最终、RTF、`phys_footprint`（活跃、TTL 后）、体积拆分；与非语音基线同机比较。
- `scripts/speech/eval.mjs`：30 条语料（中文 10、英文 5、混合 10、长句停顿噪声 5，另加静音、无语音、超长），每条记录来源、许可、说话人、起点与术语；按 4.1 节附录 B 的归一化计算 CER、WER、MER、术语召回（词典内外分开）、否定数字版本路径错误、重复与吞字；热词开关、增强与基础对比；真人录音条数如实写（没有就是 NOT RUN）。

### 5.5 手测

打包产物首次 TCC 授权、拒绝与恢复；内置麦克风真实讲话（由用户执行或标 NOT RUN）；`afplay` 外放 WAV 验证采集链路；真实输入法与 VoiceOver；截图对照参考。Windows 实机、Intel Mac 实机、蓝牙与 USB 拔插、M1 Pro 基准机标 NOT RUN 并给出命令。

## 6. 风险与待确认

| # | 风险 | 处理 |
|---|---|---|
| R1 | 子进程继承麦克风授权（未进沙箱的 Bash、hooks、用户终端） | ADR-0096 记为已接受的剩余风险；Agent Host 与沙箱 Bash 用 Seatbelt 拒绝 |
| R2 | ONNX Runtime 在主进程内崩溃会带走整个应用 | ADR-0094 列隔离条件（任何 abort、增强物理占用 > 2.5 GiB、录音时主进程事件循环 p99 > 16 ms） |
| R3 | 质量门槛在中英混合上可能不达标 | 如实报告；真人语料由用户提供，缺失标 NOT RUN |
| R4 | Qwen3 精修延迟超出 | 调线程后实测；不达标则增强标发布阻塞，默认关闭不变 |
| R5 | ad-hoc 签名每次更新后系统重新请求麦克风授权 | 授权说明文案写明；设置页可打开系统设置 |
| R6 | ModelScope CDN 在中国大陆以外较慢 | 记录；下载可续传可取消 |
| R7 | Windows ARM64、Intel Mac 没有实机 | 构建与交叉检查通过，实机 NOT RUN |

## 7. 实施步骤

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | ADR-0094–0097、本增补、PLAN 检查点 | `node scripts/plan/check-acceptance.mjs` |
| 2 | 锁文件与 `fetch-speech-assets.mjs`、`piarc-sherpa-sys`（生成脚本 + 转发层）、`[patch.crates-io]`、deny 与依赖规则 | `node scripts/dev/fetch-speech-assets.mjs && cargo test -p piarc-sherpa-sys && .tools/bin/cargo-deny check && node scripts/ci/check-crate-deps.mjs` |
| 3 | `piarc-speech` 纯模块（audio、vocabulary、transcript、session、coordinator 的逻辑） | `cargo test -p piarc-speech && cargo clippy -p piarc-speech --all-targets -- -D warnings` |
| 4 | 引擎、采集、在线识别、真实模型测试 | `PIARC_REQUIRE_SPEECH_MODELS=1 cargo test -p piarc-speech --test real_model` |
| 5 | 协议、Core 服务、NAPI、文件音源 | `npm run gen:protocol && cargo test -p piarc-core --lib dictation:: && npm run build:core -- --flavor all` |
| 6 | 主进程 IPC、授权、路由、生命周期、Info.plist 与 entitlement、Seatbelt | `npx vitest run apps/desktop/src/main && cargo test -p piarc-sandbox --test devices` |
| 7 | 渲染进程插件、控制器、按钮、听写条、波形、Composer 接入 | `npx vitest run apps/desktop/src/renderer/composer` |
| 8 | 设置页与偏好 | `npx vitest run apps/desktop/src/shared apps/desktop/src/renderer/settings` |
| 9 | 下载器、增强模型管理、精修与合并 | `cargo test -p piarc-web download && cargo test -p piarc-speech refine` |
| 10 | 打包、布局检查、L4、a11y、截图 | `npm run package:desktop -- --flavor development && node scripts/ci/check-app-layout.mjs --flavor development && PIARC_EVIDENCE_TASK=voice npx playwright test -c apps/desktop/playwright.config.ts voice- --project dev` |
| 11 | 性能探针、质量评测、体积 | `node scripts/perf/run.mjs --lane nightly --only voice-…`、`node scripts/speech/eval.mjs` |
| 12 | 文档、全量 verify、复核 | `npm run verify`、`dev-flow:spec-reviewer` |

## 附录 A：PoC 记录（2026-11-26，M1 Max / 32 GB，macOS 26.5.2，sherpa-onnx 2.0.1 no-tts 静态库，2 线程）

语料：30 条 macOS TTS（Tingting、Sandy、Reed、Shelley、Samantha）合成的 16 kHz 单声道 WAV，内容见需求 11.2 节示例与同类句子；按 20 ms 分块送入，尾部补 1.2 s 静音后 `input_finished`。合成语料只用于比较模型，不能代替真人讲话。

| 配置 | 中文 CER | 英文 WER | 混合 MER | 长句 | 术语召回 | 否定词保留 |
|---|---|---|---|---|---|---|
| 2023 双语，全 INT8，greedy | 44.4% | 51.2% | 64.2% | 17.3% | 29% | 8/8 |
| 2023 双语，全 INT8，热词 | 39.9% | 51.2% | 60.1% | 19.6% | 44% | 7/8 |
| 2023 双语，INT8 encoder + FP32 decoder/joiner | 16.3% | 48.8% | 32.4% | 4.8% | 29% | 8/8 |
| X-ASR 160 ms INT8，greedy | 7.9% | 19.5% | 35.8% | 3.6% | 38% | 8/8 |
| X-ASR 480 ms INT8，greedy | 5.1% | 4.9% | 33.8% | 3.6% | 38% | 8/8 |
| X-ASR 480 ms INT8，热词 1.5 | 4.5% | 4.9% | 27.0% | 0.6% | 56% | 8/8 |
| Qwen3-ASR 0.6B INT8，整段离线 | 1.7% | 0.0% | 23.6% | 1.8% | 65% | 8/8 |

- X-ASR 480 ms 加载 1.6 s（冷）、RTF 约 0.04；尾部静音少于 1.2 s 时吞掉末字（0.8 s 时 3 条吞字）。
- Qwen3 加载 1.8 s，整段解码 p50 1.66 s、p95 3.1 s，进程峰值 `phys_footprint` 约 1.98 GB。
- 归档：X-ASR 480 ms INT8 `fa5f63d6…`（133,895,136 字节）；Qwen3 `393f8a14…`（878,702,423 字节），其 `conv_frontend.onnx`、`encoder.int8.onnx`、`decoder.int8.onnx`、`tokenizer/{merges.txt,tokenizer_config.json,vocab.json}` 与 ModelScope `zengshuishui/Qwen3-ASR-onnx` 对应文件的 SHA-256 逐个相同；Silero VAD `9e2449e1…`（643,854 字节）。
- `bpe.vocab` 导出器对 2023 模型的输出与上游文件逐字节一致。

## 附录 B：质量评测的归一化

NFKC、全角转半角、英文转小写、合并空白；计算前去掉标点。中文按字；英文与数字按 `[a-z0-9]+`（版本号与路径里的 `.`、`/`、`-` 先换成空格）；MER 的词元是每个汉字一个、每段连续拉丁字母或数字一个。不做汉字数字与阿拉伯数字互转。术语完全一致：忽略大小写与词间空格，保留 `-`、`.`、`/`。

## 附录 C：评审裁决（2026-11-26）

| # | 意见 | 来源 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | 听写中发送位会变成 Agent 停止、Esc 中止 Agent、placeholder 与 partial 叠加、交换保护吞点击 | 产品、测试 | 采纳 | `Composer.tsx:688`、`intents.ts`；V-4.2 |
| 2 | 录音中发送的快照与精修竞争、可能重复发送 | 产品 | 采纳 | V-4.3：冻结所有权、只等基础结果、闩锁 |
| 3 | 原型底栏不适用 PiArc 单行网格 | 产品 | 采纳 | 网格加 `mic` 列；听写条起初是编辑区上方的一行、`+` 保持可用，后按用户要求改为听写期间占据操作行（V-2.3） |
| 4 | Qwen3 精修推迟到第二期 | 产品 | 不采纳 | 需求要求完整交付；增强默认关闭，实测不达标标阻塞 |
| 5 | 质量门槛改为"基线不回退" | 产品、测试 | 部分采纳 | 门槛按原文保留并如实报告；否定、数字、版本、路径单列 |
| 6 | 首次授权、拒绝后的系统设置入口、更新后重新授权、preparing 时可发送 | 产品 | 采纳 | V-2.7、V-4.4、4.8 |
| 7 | 取消破坏性大 | 产品 | 采纳 | 取消是一个撤销步；× 与停止分在两端；Esc 只停止（用户决定） |
| 8 | 窗口关闭与退出不能保留草稿 | 产品 | 采纳 | V-3.9、2.3 |
| 9 | 子进程继承麦克风授权 | 安全 | 部分采纳 | Seatbelt 拒绝 + entitlement 只给主程序；放弃 TCC 责任主体会让子进程访问文稿等目录时各自弹框，不采纳（用户确认） |
| 10 | 路由与开始听写挡不住被注入的窗口 | 安全、架构、测试 | 采纳 | `dictation/<webContentsId>` + 授权器 + `requireInput` |
| 11 | 识别文字与词典进日志或诊断包 | 安全 | 采纳 | V-9.4、诊断包替换 `customTerms` |
| 12 | 下载器的重定向、代理、上限、校验、解包 | 安全、架构 | 采纳 | ADR-0097；Qwen3 逐文件下载，不解包归档 |
| 13 | sherpa-onnx-sys 的未校验下载与构建依赖 | 安全、架构 | 采纳 | 自有 `piarc-sherpa-sys` patch，无 build.rs |
| 14 | 工作区词汇的读取边界与热词注入 | 安全、架构 | 采纳 | 3.6.1、V-6.1 |
| 15 | 静态链接 ORT 进 `.node` | 架构 | 采纳 | 运行时首次点击按绝对路径加载，计入语音资产预算 |
| 16 | 线程模型与事件投递 | 架构 | 采纳 | 4.3 |
| 17 | 资源目录参数、增强模型位置 | 架构 | 采纳 | `CoreOptions.speechDir`、`DataDirs.cache()` |
| 18 | ORT 在主进程内的风险 | 架构 | 采纳 | ADR-0094 的隔离条件 |
| 19 | 去掉 rubato、只用 sherpa 内部重采样 | 架构 | 不采纳 | 需求锁定 CPAL + Rubato；VAD 也要 16 kHz |
| 20 | 文件音源与发布构建核对 | 测试 | 采纳 | V-9.5 |
| 21 | t45 扫描会真的开麦或下载 | 测试 | 采纳 | 有副作用的命令都带参数并要求真实输入；无参命令无副作用 |
| 22 | 真实模型测试的门控 | 测试 | 采纳 | `PIARC_REQUIRE_SPEECH_MODELS` |
| 23 | 体积与内存的计量口径 | 测试 | 采纳 | 3.10、ADR-0095 |
| 24 | "合理分组""尽力保留"不可判定 | 测试 | 采纳 | V-3.3、V-3.9 改写 |
| 25 | IME 只能 L4 测 | 测试 | 采纳 | E06 |
| 26 | 语料来源与过拟合 | 测试 | 采纳 | 语料清单记录来源与许可，词典内外分开统计 |
| 27 | 主进程托盘录音指示 | 安全 | 不采纳 | macOS 与 Windows 系统已在菜单栏、通知区显示麦克风使用指示；应用内有听写条 |
