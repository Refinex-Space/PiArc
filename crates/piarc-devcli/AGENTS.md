# piarc-devcli

开发用无头驱动：不经 UI 运行 L2 场景（Core 无头运行时 + esbuild 打包的 Agent Host + `piarc-testkit` 的严格 mock）。只是 `piarc_testkit::l2` 的命令行外壳：格式、运行器与断言都在 testkit（`crates/piarc-testkit/AGENTS.md`），不在这里加场景逻辑。不随应用发布。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo run -q -p piarc-devcli -- run tests/scenarios/turn-steer.yaml` | 运行一个场景 |
| `cargo run -q -p piarc-devcli -- run tests/scenarios --json target/l2/devcli.json` | 运行目录下全部场景并写 JSON 报告（与 `scenarios` 测试的 `--results` 同一格式，可交给 `scripts/ci/check-capabilities.mjs --results`） |
| `cargo run -q -p piarc-devcli -- run tests/scenarios --filter turn- --threads 1` | 按 id 子串筛选（`--exact` 整串匹配）、串行运行便于看日志 |
| `cargo run -q -p piarc-devcli -- list tests/scenarios` | 只列出场景 |
| `cargo run -q -p piarc-devcli -- l3 <场景文件或目录> --out <目录>` | L3 的 PiArc 侧（T30）：逐个以 mock 的 L3 模式运行，写 `<目录>/<id>.json`（`failures`、`capture`）；由 `scripts/l3/run.mjs` 调用，场景是它从 `tests/l3/scenarios/` 生成的 L2 文件 |

每次运行先执行 `scripts/dev/build-agent-host.mjs`（需要 PATH 上的 node 或 `PIARC_TEST_NODE`）；`--repo <dir>` 指定仓库根，默认是编译它的那份检出。退出码：0 全部通过，1 有场景失败，2 用法或加载错误。

## 不变量

- 依赖只有 `piarc-testkit`（层规则允许 `piarc-core`、`piarc-testkit` 与基础 crate，`crates/deps-rules.json` 的 devtool 层）；发布的 crate 不得依赖它。
- 发布产物里不得出现 `piarc-devcli` 与 `piarc-mock-provider`：`scripts/ci/check-app-layout.mjs` 扫描应用目录与 `app.asar`，有就失败。
- 筛选过的运行在报告里是 `"filtered": true`，能力覆盖检查拒绝这种报告。

## 参考

- 架构第 7.1、12.3 节；`docs/engineering/testing.md` 第 12、13 节。
