# 0094. 语音输入的识别引擎、基础模型与运行时按需加载

- 状态：已接受（用户 2026-11-26 确认基础模型替换）
- 日期：2026-11-26
- 取代：无
- 相关：架构文档第 7.1、10.3、11 章；[语音输入设计增补](../architecture/addenda/voice-dictation.md)；ADR-0014、ADR-0063、ADR-0095

## 背景

语音输入要在本机离线、流式地把中英混合的讲话变成文字，不依赖 Python、外部服务或系统听写。需求原文选定 sherpa-onnx + ONNX Runtime，基础模型为 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` 的三份 INT8 权重，另配 CT-Transformer 标点模型。

PoC（设计增补附录 A，30 条合成语料，M1 Max）：

- 2023 双语模型全 INT8：中文 CER 39.9%、英文 WER 51.2%、混合 MER 60.1%，大量叠字（"测测测测试"）；换 FP32 decoder/joiner 后中文 16.3%、英文 48.8%。权重 198 MB，CT-Transformer INT8 再加 80 MB；后者的上游 FunASR 模型许可含"诋毁即丧失授权"的非标准条款。
- `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`（X-ASR-zh-en，上海交大等发布，Apache-2.0，约 100 万小时数据）：中文 4.5%、英文 4.9%、混合 27.0%（热词），自带标点与大小写，权重 169 MB，RTF 约 0.04。
- 160 ms 分块的 X-ASR 首字更快，但同语料英文 WER 19.5%。

sherpa-onnx 的 Rust 安全封装（crate `sherpa-onnx`）依赖 `sherpa-onnx-sys`，后者的 build.rs 在没有设置 `SHERPA_ONNX_LIB_DIR` 时从 GitHub 下载预编译库且不校验，并默认静态链接（带 TTS 的版本含 espeak-ng，GPL-3.0）。静态链接会把约 75 MB 的 `libonnxruntime.a` 链进 Core 的 `.node`：应用启动时就执行 ONNX Runtime 的初始化，每个链接 Core 的测试二进制都要链入它，安装后体积计入非语音预算（余量 3 MB），Windows 上 static-MT 归档与 Rust 默认的 /MD 冲突。

在线识别器、流与 VAD 对象不是 `Send`。

## 决策

1. 基础模型用 X-ASR-zh-en 480 ms INT8（encoder.int8、decoder、joiner.int8、tokens、bpe.model，加构建期由 bpe.model 导出的 bpe.vocab），随安装包内置；不用 CT-Transformer，标点来自模型本身。VAD 用 Silero VAD（`silero_vad.onnx`）。partial 按模型分块每 480 ms 更新，这是模型粒度，不是人为延迟。
2. 引擎用 sherpa-onnx v2.0.1：安全封装 `sherpa-onnx = "=2.0.1"` 原样使用；`sherpa-onnx-sys` 经 `[patch.crates-io]` 换成仓库自己的 `crates/piarc-sherpa-sys`（同名同版本）：结构体照抄上游 2.0.1，函数由 `scripts/dev/gen-sherpa-sys.mjs` 生成为同名 `pub unsafe fn`，经 `libloading` 转发到运行时加载的函数表。没有 build.rs，不下载、不链接。
3. 运行时用官方 `*-shared-no-tts-lib` 动态库（Windows 为 `shared-MD-Release-no-tts-lib`），放在 `Resources/speech/runtime/`，首次点击麦克风时按绝对路径加载（先 ONNX Runtime 再 C API，Windows 不按名字搜索）。加载后不卸载；模型与识别器在空闲 60 s 后释放。
4. 识别在 Electron 主进程内的 Core 里运行：一个专用引擎线程持有运行时对象、在线识别器、VAD 与 CPAL 的 Stream；精修在另一个线程。引擎只经纯数据的命令与事件与外界交互。
5. 满足以下任一条件时，把引擎移到独立子进程（新 ADR）：压测或故障注入出现 ONNX Runtime 的 abort；增强模式物理占用超过 2.5 GiB；录音期间主进程事件循环 p99 超过 16 ms。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 2023 双语模型 + CT-Transformer（需求原文） | 原文锁定 | 质量差一个数量级，多 110 MB，标点模型许可不清 | 不采用（用户确认） |
| X-ASR 160 ms | partial 更密 | 英文 WER 19.5% | 不采用 |
| 静态链接进 `.node` | 上游默认，最简单 | 启动即初始化 ORT、测试链接慢、计入非语音预算、Windows CRT 冲突 | 不采用 |
| 上游 `shared` 特性（链接期依赖动态库） | 不改 sys crate | `.node` 加载时就装载 ORT，库缺失时 Core 整个起不来 | 不采用 |
| 独立子进程运行引擎 | 崩溃隔离、内存彻底释放 | 新常驻进程与协议，需求要求先进程内 | 列为重新评估条件 |

## 后果

- 正面：不点麦克风时 Core 不装载 ONNX Runtime；运行时缺失只让语音不可用，不影响启动；没有未校验的构建期下载；第三方 build 依赖（ureq、zip、bzip2）不进依赖图。
- 负面与代价：维护一个生成的转发层，升级 sherpa-onnx 时重新生成；ORT 在主进程内崩溃会带走应用；ORT 加载后代码页常驻。
- 需要配套做的事：`deps-rules.json` 加 sys 层成员与例外、`unsafe` 白名单、`third-party/speech-assets.lock.json`、NOTICES。

## 重新评估的触发条件

- 第 5 条的任一条件出现。
- sherpa-onnx 发布含所需修复的新版本，或 X-ASR 发布更好的流式模型。
- 真人语料上 X-ASR 达不到设计增补 V-6.5 的门槛。
