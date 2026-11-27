# piarc-speech

本地语音输入（ADR-0094–0097，设计增补 `docs/architecture/addenda/voice-dictation.md`）：麦克风采集（CPAL，`capture`）、下混与重采样到 16 kHz 及电平（`audio`）、分段协调（Silero VAD + 在线识别器的端点）、流式识别（X-ASR zh-en 480 ms INT8，热词）、可选的 Qwen3-ASR 精修与保守合并、词汇（内置术语、用户词典、受信任工作区的包名）、文本规范化（`transcript`）与会话状态机；全部 sherpa-onnx 对象由引擎线程独占（它们不是 `Send`）。不负责：谁能听写、事件路由、设置读取与信任（Core 的 `piarc_core::dictation`），下载（`piarc_web::download`）。依赖：`piarc-protocol`、`sherpa-onnx` 与 `sherpa-onnx-sys`（`crates/piarc-sherpa-sys`，登记的单向例外）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-speech` | 纯模块：音频、词汇与词条校验、规范化、协调器、状态机（替身识别器）、清单与校验 |
| `node scripts/dev/fetch-speech-assets.mjs` | 按 `third-party/speech-assets.lock.json` 下载并校验运行库与模型，摆到 `target/speech-assets/<平台>-<架构>/`，测试 WAV 在 `target/speech-assets/test-wavs/` |
| `PIARC_REQUIRE_SPEECH_MODELS=1 cargo test -p piarc-speech --features testing --test real_model -- --nocapture` | 真实模型经生产管线：partial 先于结束、末字保留、48 kHz 立体声、静音无字、确定性、电平随语音起伏、THR-18 金丝雀（不写文件）。不设变量时打印 NOT RUN |
| `cargo run --release -p piarc-speech --features testing --example voice-bench -- --assets <目录> --list <tsv>` | 逐条以实时节奏播放 WAV：文字、首个 partial、停止到最终、CPU 实时率、冷加载、`footprint`；`scripts/speech/eval.mjs` 与 `scripts/perf/probe-voice.mjs` 调它 |
| `cargo clippy -p piarc-speech --all-targets --features testing -- -D warnings` | lint（也跑一遍不带 feature 的） |

## 不变量

- 运行库与模型加载前按锁文件核对大小与 SHA-256（`models::verify`），不符即 `modelCorrupt`，不加载；打包不能改写这些文件的字节（macOS 上语音动态库保留上游签名，见 `apps/desktop/forge.config.ts`）。
- `testing` feature 只给开发构建：`wav_source` 用 WAV 文件代替麦克风（标记字符串 `wav_source::MARKER`，发布构建的 `.node` 里不能出现，`check-app-layout` 检查）。
- 音频只在进程内有界缓冲，不写文件；识别文字与词汇不写日志（THR-18）。本 crate 没有日志语句，新增时不要带文字。
- X-ASR 需要尾部 ≥ 1.2 s 静音再 `input_finished`，否则吞末字；热词要 `modeling_unit=bpe` 与由 `bpe.model` 导出的 `bpe.vocab`，词条以 `/` 分隔，所以词条拒绝 `/`、`:`、`,`、控制与双向字符（`vocabulary::check_term`，渲染进程 `voiceTermProblem` 同一规则）。
- 规范化只做三件事（V-6.2）：已知词条的大小写、拆开的已知缩写、中英文之间的空格（汉字之间与中文标点两侧不留空格）。

## 易错点

- ONNX Runtime 多线程推理的浮点累加顺序不固定：边界词（如"频繁 / 平凡"）在重采样后的音频上会逐次翻转，真实模型测试不要断言这种词。
- `fetch-speech-assets.mjs` 每次先删后建 `target/speech-assets/<目标>/`：打包与真实模型测试不要同时跑。
