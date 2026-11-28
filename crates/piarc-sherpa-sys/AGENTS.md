# piarc-sherpa-sys（包名 sherpa-onnx-sys）

sherpa-onnx-sys 2.0.1 的运行时转发层（ADR-0094）：`scripts/dev/gen-sherpa-sys.mjs` 把上游 crate 的 `extern "C"` 声明改写成同名同签名的函数，经运行时解析的函数表（`src/table.rs`，生成）调用 `loader.rs`（手写）按绝对路径加载的 `libsherpa-onnx-c-api` 与 ONNX Runtime。经根 `Cargo.toml` 的 `[patch.crates-io]` 顶替上游，供上游的安全封装 `sherpa-onnx` 使用。不下载、不链接、没有构建脚本；不校验文件（`piarc-speech` 校验）。只有 `piarc-speech` 能依赖它（`crates/deps-rules.json`）。

## 命令

| 命令 | 用途 |
|---|---|
| `node scripts/dev/gen-sherpa-sys.mjs [--check]` | 重新生成（或比对）`src/` 的生成文件；升级 sherpa-onnx 时运行 |
| `cargo test -p sherpa-onnx-sys` | 加载器的单测 |

## 不变量

- 生成文件不手改，改生成器再运行；`loader.rs` 的 `REQUIRED` 符号必须是 C API 真实导出的名字（缺一个就整体报 `runtimeMissing`）。
- `unsafe` 只在本 crate（-sys 层，编码规范 2.8）；许可证 Apache-2.0，`NOTICE` 列出相对上游的改动。
