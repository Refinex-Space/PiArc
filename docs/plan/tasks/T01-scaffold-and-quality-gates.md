# T01 仓库脚手架、工程规范与质量门禁

| 项 | 内容 |
|---|---|
| 阶段 | 0 工程基座 |
| 依赖 | 无（开工前，规划文件已提交） |
| 执行平台 | macOS（CI 同时覆盖 Windows） |
| 推荐配置 | Opus 5.5，effort high，新会话 |
| 规模 | 大 |
| 关联验证项 | 无 |
| 需要的用户决定 | 无 |

启动方式：在仓库根目录开新会话，输入 `/task T01`，或粘贴本文件全部内容。

## 执行要求

开工前完整阅读 `docs/plan/protocol.md` 并严格遵守。开工检查、范围与决策分级、质量门禁、验收记录、收尾与报告格式都以它为准。最重要的几条：

- 先读后写；外部 API 以锁定版本为准，Pi 的读法见 `docs/plan/references.md`。
- 只做本任务范围内的事；补充型决策自己定，变更型决策写 ADR 提议后停止受影响部分。
- clean-room：参考仓库只学行为，不复制 claude-code 与 OpenClaudeDesktop 生成组件的任何代码、提示词和品牌资产（ADR-0006）。
- 不删改测试和验收项；只有亲自验证通过的验收项才能标 `passing`。
- 每完成一个检查项就更新 `PLAN.md` 检查点并提交；上下文会被自动压缩，不要提前停下。
- 不推送，不打印凭据。

## 背景与目标

仓库目前只有文档。本任务搭建三类工作区的骨架：npm workspaces（TypeScript）、Cargo workspace（Rust）、CI。同时把架构中能自动化的约束变成检查失败条件，例如 crate 依赖方向、格式、lint、类型、许可证、验收清单一致性。

之后每个任务都在这套门禁下工作，所以它必须一次做对：门禁漏掉的东西，后面会悄悄漂移。

完成后，`npm run verify` 一条命令在 macOS 与 Windows 上都能跑完全部检查；违反任何一条规则，检查失败并给出可读的原因。

## 必读

1. 架构设计 `docs/architecture/ARCHITECTURE.md`：
   - 第 3.4 节"仓库结构"
   - 第 5.7 节"跟随上游"
   - 第 7.1 节"Crate 划分"，含依赖规则
   - 第 12.1 节与第 12.6 节"测试分层""测试纪律"
   - 第 13 章"工程结构、构建与发布"
   - 第 15.3 节"现在就要遵守的约束"
2. ADR-0013、ADR-0014、ADR-0015。
3. 需求规格 NFR-09、NFR-10。
4. `docs/plan/protocol.md`、`docs/plan/PLAN.md` 全文。

## 范围

### 要做

- npm workspaces 与 TypeScript 工具链骨架。
- Cargo workspace 与全部 crate 骨架。
- 统一检查入口 `npm run verify`，以及它调用的检查脚本。
- 编辑器与 Git 属性文件、GitHub Actions CI（macOS 与 Windows）。
- 三份工程规范、两份 `.claude/rules`、根 `CLAUDE.md` 的"交付流程"与"命令"两节。

### 不做

- Electron 应用（T03）、NAPI 绑定（T04）、Pi 依赖（T06）、协议类型（T02）。
- 任何业务逻辑。

## 交付物

### 1. npm workspaces 与 TypeScript 工具链

- 根 `package.json`：`private: true`，`workspaces` 为 `apps/desktop`、`agent-host`、`packages/protocol`。三个工作区只建包骨架：`package.json`、`tsconfig.json`、`src/index.ts`（导出一个空模块即可），不引入 Electron、Pi 或 React。
- `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`，`module`/`moduleResolution` 用 `NodeNext`。
- ESLint flat config + typescript-eslint（类型感知规则），Prettier（与 ESLint 不冲突），Vitest。
- `.nvmrc`：Node LTS。大版本与当前受支持的最新 Electron 稳定版内置的 Node 一致（撰写时为 24），取发布至少两周的最新补丁版本。
- 依赖版本精确锁定（不用 `^`、`~`），`package-lock.json` 入库。

### 2. Cargo workspace

- 根 `Cargo.toml`：workspace（resolver 3），`[workspace.package]` 统一 edition、license（MIT）、rust-version；`[workspace.dependencies]` 集中声明依赖版本，crate 中一律 `workspace = true`。
- 按架构第 7.1 节建全部 crate：
  - 组成：`piarc-protocol`、`piarc-core`、`piarc-host`、`piarc-policy`、`piarc-hooks`、`piarc-config`、`piarc-fs`、`piarc-checkpoint`、`piarc-ports`、`piarc-exec`、`piarc-term`、`piarc-ghostty-sys`、`piarc-sandbox`、`piarc-store`、`piarc-diff`、`piarc-git`、`piarc-secrets`、`piarc-telemetry`、`piarc-napi`、`piarc-testkit`、`piarc-devcli`；
  - 每个 crate 只有 `Cargo.toml` 和 `src/lib.rs`（`piarc-devcli` 为 `src/main.rs`）；
  - `lib.rs` 只写 crate 级文档（`//!`，英文）：职责、不负责什么、允许依赖的 crate。允许依赖的 crate 照抄架构的依赖规则。
- `rust-toolchain.toml` 锁定 stable 的具体版本，组件含 `rustfmt`、`clippy`。
- `rustfmt.toml`；clippy：
  - workspace lints 设 `-D warnings` 级别的严格度；
  - `clippy.toml` 中 `too-many-lines-threshold = 80`；
  - 开启 `allow_attributes_without_reason`：架构第 7.1 节规定，超过 80 行的函数要说明理由，所以 `#[allow(clippy::too_many_lines)]` 必须带 `reason`。
- `deny.toml`（cargo-deny）：
  - 许可证白名单：MIT、Apache-2.0、Apache-2.0 WITH LLVM-exception、BSD-2/3-Clause、ISC、Unicode-3.0、Zlib，MPL-2.0 视需要；
  - 禁止 GPL/AGPL/LGPL 进入依赖树；
  - 安全公告检查。
  - 需要用户同意才能全局安装 cargo-deny 时，先征得同意；或改用不需要全局安装的方式，并在报告中说明。

### 3. 检查脚本（全部用 Node 编写，跨平台，不写死路径分隔符）

- `scripts/ci/check-crate-deps.mjs`：读取 `cargo metadata --format-version 1`，按 `crates/deps-rules.json` 校验 crate 之间的依赖方向，违规时列出"哪个 crate 依赖了哪个不允许的 crate"并退出非 0。
  - `deps-rules.json` 照抄架构第 7.1 节：`piarc-napi → piarc-core → 功能 crate → {piarc-protocol, piarc-ports}`；功能 crate 之间默认不允许互相依赖，`fs → checkpoint`、`term → ghostty-sys` 这类明确的例外逐条列出并附理由。
- `scripts/plan/check-acceptance.mjs`：
  - 解析 `docs/plan/tasks/*.md` 中所有 `- [Txx-Ayy] 描述` 形式的验收项（含 `W0-A01`、`R1-A01` 这类编号）；
  - 与 `docs/plan/acceptance.json` 的 `items` 比对：编号一一对应、`task` 字段一致、`description` 逐字一致；
  - 有缺失、多余或不一致时列出并退出非 0。
- `scripts/dev/verify.mjs`：按顺序执行下列检查，每步打印名称与结果，任一步失败则最终退出非 0（继续执行后续步骤，方便一次看到全部问题），最后打印汇总表：
  1. Prettier `--check`
  2. ESLint
  3. `tsc --build`（或各工作区 `tsc --noEmit`）
  4. Vitest
  5. `cargo fmt --check`
  6. `cargo clippy --workspace --all-targets`
  7. `cargo test --workspace`
  8. cargo-deny
  9. crate 依赖检查
  10. 验收清单一致性检查
- 根 `package.json` 的 `scripts`：`verify`、`format`（写入）、`lint`、`typecheck`、`test`。

### 4. 其他文件

- `.editorconfig`：UTF-8、LF；TS/JSON/YAML 2 空格；Rust 4 空格。
- `.gitattributes`：默认 `* text=auto eol=lf`；为将来的 CRLF 测试夹具保留例外目录（例如 `tests/fixtures/crlf/** -text`），并在 testing.md 中说明。
- `.github/workflows/ci.yml`：
  - 矩阵 `macos-latest`（arm64）与 `windows-latest`；
  - 安装 `.nvmrc` 的 Node 与 `rust-toolchain.toml` 的 Rust，缓存 npm 与 cargo；
  - 执行 `npm ci --ignore-scripts` 与 `npm run verify`。
- `.claude/settings.json`：已存在时只追加本任务新用到的、安全的命令到 `allow`；不放宽 `deny`。

### 5. 工程规范（`docs/engineering/`，中文）

- `coding-standards.md`：
  - Rust：crate 内模块组织、命名、错误类型化（`thiserror`，带 `kind` 与 `retryable`，跨 NAPI/AHP 时映射为结构化错误）、panic 不得穿过 NAPI 边界、I/O 边界用窄 trait 隔离、文件 1000 行与函数 80 行规则、`unsafe` 规则（只在 `-sys` 层与 NAPI 边界，必须有 `// SAFETY:` 注释）。
  - TypeScript：严格模式、禁止 `any`（确需时 `unknown` + 收窄）、模块边界、Pi 深度 import 禁令（T06 落地为 ESLint 规则）。
  - 通用：代码、注释、提交信息用英文；设计文档用中文；Conventional Commits；"通用能力复用"表，初始为空，由后续任务追加。
- `testing.md`：
  - L0–L4 分层（对应架构第 12.1 节），以及安全回归与性能测试；
  - 各层的命名与目录约定、运行命令；
  - fixture 纪律（架构第 12.6 节）、CRLF 夹具目录；
  - 测试证据存放（`tmp/evidence/<任务编号>/`，不入库）；
  - 真实服务商测试的成本约束。
- `claude-md.md`：
  - CLAUDE.md 的分层：根目录、各包与 crate；
  - 长度上限：根文件 200 行，子目录 120 行；
  - 只写"读代码看不出来、每次都需要"的信息；提供模板。

### 6. `.claude/rules` 与根 `CLAUDE.md`

- `.claude/rules/rust.md`（`paths: crates/**`）、`.claude/rules/typescript.md`（`paths: apps/**, agent-host/**, packages/**, scripts/**`）：各自不超过 40 行的精要规则，指向 coding-standards.md 的对应章节。
- 根 `CLAUDE.md`：
  - 不存在时按 claude-md.md 的模板创建；
  - 已存在（例如用户用 `/dev-flow:deep-init` 生成过）时，只补"交付流程"与"命令"两节，不改其他内容。
  - "交付流程"写明：按 `docs/plan/PLAN.md` 推进、每个任务一个会话用 `/task <编号>`、遵守 `docs/plan/protocol.md`、架构基线与 ADR 的关系。
  - "命令"只写实际执行成功过的命令。

## 实现要点

- **先跑通最小骨架，再加门禁**：先确认空工作区与空 crate 都能构建，再逐个加入检查，每加一个就跑一次，避免多个问题叠在一起。
- Windows 兼容：脚本里拼路径用 `path.join`，调用外部命令用 `child_process.spawn` 加参数数组（不拼 shell 字符串），`npm` 在 Windows 上是 `npm.cmd`，用 `shell: process.platform === 'win32'` 或 `cross-spawn` 处理。不新增依赖能解决的，就不新增依赖。
- crate 依赖规则在本任务时几乎都是空依赖，规则会自然通过。用临时违规验证检查确实生效，验证后撤销。
- `check-acceptance.mjs` 必须能处理验收项描述中的反引号、括号、中文标点。

## 验收标准

- [T01-A01] 干净检出上执行 `npm ci --ignore-scripts` 与 `npm run verify` 通过，汇总表列出 10 个检查步骤全部成功。验证：命令输出。
- [T01-A02] 格式检查生效：故意破坏一个 `.rs` 文件与一个 `.ts` 文件的格式，`npm run verify` 分别在 `cargo fmt --check` 与 Prettier 步骤失败并指出文件；恢复后通过。验证：两次运行的关键输出。
- [T01-A03] lint 与类型检查生效：临时引入一个 clippy 警告、一个 ESLint 违规、一个 TS 类型错误，verify 分别在对应步骤失败；撤销后通过。验证：关键输出。
- [T01-A04] 80 行函数规则生效：临时写一个超过 80 行的 Rust 函数，clippy 报 `too_many_lines`；加上不带 `reason` 的 `#[allow]` 仍然失败；加上带 `reason` 的 `#[allow]` 后通过。验证：三次运行的关键输出。
- [T01-A05] crate 依赖检查生效：临时让 `piarc-policy` 依赖 `piarc-hooks`，`check-crate-deps.mjs` 失败并指出这条依赖；撤销后通过。验证：关键输出。
- [T01-A06] 许可证检查生效：临时引入一个 GPL 许可证的 crate（只为演示，不提交），cargo-deny 失败并指出许可证；撤销后通过。验证：关键输出。
- [T01-A07] 验收清单检查生效：临时改动 `acceptance.json` 中一条描述、再临时删除一条，`check-acceptance.mjs` 分别报告"描述不一致""缺失"；恢复后通过。验证：关键输出。
- [T01-A08] 每个 crate 都有 crate 级文档，写明职责、不负责什么、允许依赖的 crate，与架构第 7.1 节一致；`crates/deps-rules.json` 与架构一致。验证：列出 crate 清单与 `deps-rules.json` 内容摘要。
- [T01-A09] `ci.yml` 语法有效，且矩阵包含 macOS 与 Windows（有 actionlint 就用 actionlint，否则用 YAML 解析器校验）。验证：命令输出。
- [T01-A10] 三份工程规范存在，内容覆盖"交付物 5"列出的要点，且与架构设计不冲突。验证：列出各文档的章节标题。
- [T01-A11] 根 `CLAUDE.md` 有"交付流程"与"命令"两节，"命令"中每条命令都实际执行成功过。验证：在报告中列出命令与结果。
- [T01-A12] 所有 TS 依赖精确锁定（`package.json` 中没有 `^`、`~`），Cargo 依赖都经 `[workspace.dependencies]` 声明。验证：检查命令输出（例如 grep 结果为空）。

## 收尾

按 `docs/plan/protocol.md`"收尾"执行。另外：

- 把临时制造的违规全部撤销，确认 `git status` 只包含本任务的正式产物。
- 在 `coding-standards.md` 的"通用能力复用"表中登记本任务产出的脚本（verify、依赖检查、验收清单检查）。
