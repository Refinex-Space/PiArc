---
paths:
  - "crates/**"
---

# Rust 规则（精要）

完整规范见 `docs/engineering/coding-standards.md` 第 2 章。

- 依赖方向以 `crates/deps-rules.json` 为准：`piarc-napi → piarc-core → 功能 crate → {piarc-protocol, piarc-ports}`，功能 crate 之间不互相依赖。新增单向例外要写理由；反转方向先写 ADR（2.1）。
- 依赖版本只写在根 `Cargo.toml` 的 `[workspace.dependencies]`，crate 中用 `workspace = true`；许可证必须在 `deny.toml` 白名单内（1.4）。
- crate 根的 `//!` 文档保持三段：职责、不负责什么、允许依赖的 crate；改依赖时同步更新（2.1）。
- 错误用 `thiserror` 枚举，提供 `kind()` 与 `retryable()`；跨 NAPI/AHP 映射为结构化错误；库 crate 不用 `anyhow`（2.3）。
- 非测试代码不用 `unwrap()`；`todo!`、`unimplemented!`、`dbg!` 不得提交；panic 不得穿过 NAPI 边界（2.4）。
- I/O 走 `piarc-ports` 的窄 trait，进程启动统一经 `ProcessSpawner`；平台代码只在 trait 实现里用 `cfg(target_os)`（2.5）。
- 函数不超过 80 行，文件不超过 1,000 行；确需超过时 `#[expect(clippy::too_many_lines, reason = "...")]`（2.7）。
- `unsafe` 只在 `piarc-ghostty-sys`、`piarc-napi`、`piarc-term` 的 `vt` 与 `console`（Windows）模块、`piarc-exec` 的 `job`、`tty_processes`（macOS）与 `tcp_table`（Windows）模块、`piarc-browser-import` 的 `dpapi`（Windows）模块，每个 `unsafe` 块前写 `// SAFETY:`（2.8）。
- 放宽 lint 必须带 `reason`，优先用 `#[expect]`（2.9）。
- 路径用 `std::path`，不拼分隔符；测试覆盖 LF/CRLF 与含空格、中文的路径（1.5，`testing.md` 第 4 节）。
- 改完运行 `cargo test -p <crate>` 与 `cargo clippy -p <crate> --all-targets -- -D warnings`。
