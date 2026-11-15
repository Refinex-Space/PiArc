# S5 凭据保险箱与 Pi 凭据接口适配

- 任务：T08（2026-11-15）
- 范围：保险箱本身的正确性与安全性；它与 Pi 凭据接口的适配，包括多会话、多个 Agent Host 的缓存一致（架构第 5.4、9.1 节，ADR-0018 第 5 条）。
- 结论：macOS **通过**。加解密往返正确，改动文件任一字节都读不出任何条目；主密钥在登录钥匙串中的创建、读取、删除与各错误路径符合状态表；Pi 1.5.2 的凭据注入点是异步接口，适配层按"启动取回、内存读、加锁写回"运行；一次登录、两个 Agent Host 的三个会话同时使用即将过期的 token，只刷新一次，所有请求都用新 token，保险箱与各会话一致；数据目录、日志与临时目录中搜不到明文，Agent Host 及其子进程的环境变量中没有凭据。设计决策见 ADR-0021。待 W0：Windows 凭据管理器实机与 Windows 数据目录扫描；待 T12：两次构建之间的钥匙串弹窗次数。

## 1. 验证环境

| 项 | 版本 |
|---|---|
| 系统 | macOS 26.5.2（25F84），Apple M1 Max |
| Node | 本机 24.14.1 |
| Pi | `@earendil-works/*` 1.5.2 |
| Agent Host | `npm run build:agent-host` 的单文件 bundle（约 15 MB） |
| Core | `piarc-secrets`（保险箱）、`piarc-core::secrets::SecretsService`（AHP 应答），Rust 1.99.1 |
| 加密 | `aes-gcm` 0.11.1（RustCrypto，AES-256-GCM），随机数 `getrandom` 0.4.3 |
| 系统凭据库 | `keyring-core` 1.0.1；macOS `apple-native-keyring-store` 1.0.2（`keychain` 特性，登录钥匙串）；Windows `windows-native-keyring-store` 1.1.0（只编译，未实机运行） |
| 模型侧 | `piarc-testkit` 严格 mock provider（OpenAI Chat Completions 线格式）与测试内的本地 token 端点 |

依赖都在 `deny.toml` 的许可证白名单内（MIT 或 Apache-2.0），`cargo-deny` 通过。

## 2. Pi 的凭据接口

架构第 5.4 节写的是"Pi 的 `AuthStorageBackend.withLock` 是同步接口"，风险 R11 据此担心同步接口对不上异步的凭据库。核对 Pi 1.5.2 的类型声明：

- `ModelRuntime.create({ credentials })` 接受 pi-ai 的 `CredentialStore`（`pi-coding-agent` `dist/core/model-runtime.d.ts`），`read`、`list`、`modify`、`delete` 都返回 Promise（`pi-ai` `dist/auth/types.d.ts`）。
- `AuthStorageBackend.withLock` 只是 coding-agent 的 `AuthStorage`（`auth.json` 加 `proper-lockfile`）的后端接口。传入 `credentials` 后 Pi 不再用它，`pi/` 下也就不会出现 `auth.json`。
- pi-ai 在 `modify` 内刷新 OAuth（`dist/auth/resolve.js`）：剩余有效期不到 5 分钟时刷新，刷新本身超时 15 秒；进入锁后用 `needsRefresh` 复查，别人已经刷新过就不再刷新；接口约定要求同一 provider 的修改互斥，"后端支持时跨进程也互斥"，并在释放锁之前持久化。

所以 R11 在这个注入点不出现；适配层仍按架构的做法把凭据放在内存，原因变成了"读不必每次跨进程"和"多个 Agent Host 要一致"。

## 3. 保险箱文件格式

```text
offset  size  field
     0     8  魔数 "PIARCVLT"
     8     2  格式版本（小端，1）
    10    16  主密钥标识：SHA-256("piarc-credential-vault-key-id\0" ‖ 主密钥) 的前 16 字节
    26    12  AES-GCM nonce，每次写入重新随机生成
    38     n  明文文档的密文
  38+n    16  GCM 认证标签
```

- 前 38 字节头部是附加数据：头部、nonce、密文、标签的任一字节变化都无法通过认证。
- 明文是 JSON：`{ nextRevision, entries: { "<键>": { revision, updatedAt, value } } }`。`value` 是凭据的 JSON 文本；键名也只在密文里。`revision` 来自整个保险箱的计数，删除同样占一个，重建的键不会复用旧 revision。
- 键：`provider/<id>`（API key）、`oauth/<id>`（OAuth token）、`mcp/<server>`（预留给 T36）；值必须是 JSON 对象，单条不超过 64 KiB。
- 写入：整份文档重新加密，写到同目录 `secrets.vault.tmp-<随机>`（权限 0600）、`fsync`、rename 覆盖。打开时清掉上次崩溃留下的临时文件（里面只有密文）。内存中的状态只在 rename 成功后才改。
- 清零：主密钥、明文缓冲与条目值放在 `Zeroizing` 中，释放时清零；序列化写入一个扩容时清零旧缓冲的写入器。`serde_json` 解析时的内部临时缓冲不在控制范围内。错误与 `Debug` 输出不含凭据值：`InvalidValue` 只写键名与原因；Core 的参数错误不带 serde 的原文，因为 serde 的类型错误会引用出错的值（测试中断言过）。

## 4. 主密钥与状态表

主密钥是 32 字节随机数，存在系统凭据库：服务名 `<应用标识>.credential-vault`，账户 `master-key`。应用标识集中定义在 `piarc-core::identity::APP_IDENTIFIER`。D2（应用标识与产品域名）尚未落实，当前是明显不像反向域名的占位值 `PiArc.pending-D2`。

macOS 用**登录钥匙串**（`apple-native-keyring-store` 的 `keychain` 模块），不用 data protection keychain：后者的 access group 来自签名 entitlement，需要 provisioning profile 授权，ad-hoc 签名的构建没有（`docs/research/native-stack.md` 第 8.4 节，Apple TN3137）。代价是登录钥匙串条目的访问控制绑定应用的代码身份，ad-hoc 签名每次更新身份都变，所以每次更新后会弹一次授权；只有一个条目，所以最多一次（T12 实测）。

| 情况 | 行为 | 测试 |
|---|---|---|
| 没有保险箱、没有主密钥 | 生成主密钥写入凭据库，写空保险箱 | `first_run_creates_the_key...` |
| 没有保险箱、有主密钥 | 用已有主密钥写空保险箱 | 同上 |
| 有保险箱、主密钥可用 | 认证后解密 | `round_trips_entries...` |
| 有保险箱、主密钥缺失 | `masterKeyMissing`；不新建主密钥，凭据库写入次数不变，文件 SHA-256 不变 | 同上 |
| 凭据库拒绝、锁定、不可用 | `credentialStoreUnavailable`，`retryable: true`，`details.reason` 为 `accessDenied`/`unavailable`/`failed`；首次运行时数据目录中一个文件都不写，已有保险箱时只有密文文件 | `an_unusable_credential_store...` |
| 保险箱被改动 | `vaultIntegrity`，不返回任何条目；用另一把主密钥封装的文件带 `keyIdMatches: false` | `any_modified_byte...` |
| 格式版本未知 | `vaultVersion`，`details.version` | `an_unknown_format_version...` |

macOS 的平台错误按 OSStatus 分类：`errSecUserCanceled`（-128）与 `errSecAuthFailed`（-25293）为 `accessDenied`，`errSecInteractionNotAllowed`（-25308）与 keyring-core 的 `NoStorageAccess` 为 `unavailable`，其余为 `failed`。Windows 上 `NoStorageAccess` 为 `unavailable`，其余为 `failed`，W0 实机确认。

Core 在第一次 `secrets/*` 请求时打开保险箱；打开失败只让这次请求失败，下一次请求重新打开。用户在钥匙串提示中先拒绝、之后再允许时，不需要重启（端到端测试 `a_refusing_credential_store_fails_the_turn_and_recovers`）。

## 5. AHP 与 Core 侧

| 方法 | 方向 | 作用 |
|---|---|---|
| `secrets/getAll` | Agent Host → Core | 启动时取回全部凭据；该连接登记为变更订阅者 |
| `secrets/get` | Agent Host → Core | 读一条 |
| `secrets/set`、`secrets/delete` | Agent Host → Core | 写或删一条，可带 `lockId`；返回 `revision` |
| `secrets/lock` | Agent Host → Core | 一组键一起加锁，返回它们的当前值与 `expiresInMs` |
| `secrets/unlock` | Agent Host → Core | 释放锁 |
| `secrets/changed` | Core → Agent Host | 推送一次写入：`{ key, revision, value? }`，删除时没有 `value` |

每个消息都有 JSON Schema 与 golden 样本（`tests/contracts/secrets/`，13 个契约，每个至少一个合法样本和一个反例），Rust 往返与 TS 的 ajv 校验都通过。

一个 Core 只有一个 `SecretsService`，所有 Agent Host 共用。锁表按键记录持有者；`secrets/lock` 在任一键被占用时等待（用 `Notify`，释放时唤醒）；未带 `lockId` 的写入先临时锁住该键再写。锁在 `secrets/unlock`、租约到期（默认 30 秒，长于 pi-ai 的 15 秒刷新超时）或持有者的连接结束时释放；带着已失效的 `lockId` 写入返回 `secretLockLost`。变更按连接各开一个任务推送，一个停止读取的 Agent Host 只拖慢它自己；接收方按 `revision` 判断新旧，到达顺序不影响结果。

Core 侧测试（`crates/piarc-core/tests/secrets.rs`）：推送只发给订阅者、关闭的连接被移除；凭据库拒绝时返回结构化错误且不写文件，授权后下一次请求成功；主密钥缺失；锁阻塞同键写入、不阻塞别的键；租约到期与连接结束都会释放锁；两个连接各做 25 次"加锁、读、加一、写、解锁"，结果为 50。

## 6. Agent Host 适配层

`agent-host/src/runtime/credentials.ts` 的 `CoreCredentialStore` 实现 pi-ai 的 `CredentialStore`：

- **启动**：`load()` 调 `secrets/getAll`，失败时记下错误，不让 Agent Host 退出；之后每个需要凭据的操作先重试一次，仍失败就以 Core 的结构化错误拒绝。
- **读**：`read`、`list` 从内存返回，不访问 Core（测试：100 次读不产生请求）。
- **写**：`modify`、`delete` 按 provider 串行（promise 链，`signal` 只取消排队）；每次先 `secrets/lock` 锁住 `provider/<id>` 与 `oauth/<id>`，用锁返回的当前值更新内存，再运行 `fn`；有新值时先更新内存（其他会话立刻读到），再 `secrets/set`，Core 存好后 `modify` 才完成；最后 `secrets/unlock`。API key 与 OAuth 互相切换时删除另一个键。
- **写回失败**：`modify` 拒绝。pi-ai 把它包成 `ModelsError("auth")`，该次模型请求失败，会话以 `turn/completed` 的 `failed` 带 `errorMessage` 报出。新值留在内存：轮换后的 refresh token 只存在于那里，丢掉它会迫使用户重新登录。
- **其他写入方**：`secrets/changed` 经 `applyChange` 更新内存，`revision` 不高于已知值的通知丢弃；`mcp/*` 不进 Pi 的凭据视图。
- **退出**：有序退出前等待进行中的写入完成（`flush`）。

"写操作异步回写 Core"在这里的含义是：写回是一个异步的 AHP 请求，发出前内存已经更新，读不等它；`modify` 的完成等它。只更新内存就完成的做法被否决（ADR-0021 备选方案）：pi-ai 要求释放锁前持久化，否则 Agent Host 在确认前退出会丢掉轮换后的 refresh token，写回失败也无法归到某次请求上。

**Pi 接口契约测试**（`agent-host/src/runtime/credentials.test.ts`）：从 Pi 1.5.2 的 `packages/ai/test/models-runtime.test.ts`（MIT）改写六个用例，对 pi-ai 的 `InMemoryCredentialStore` 与 `CoreCredentialStore` 各跑一遍：经凭据存储的登录与登出、剩余不到 5 分钟时刷新并持久化、并发刷新只刷新一次、刷新失败时保留原凭据、排队的修改被取消后不再执行、存了凭据就不回退到环境变量。两者全部通过。另有 PiArc 自己的用例：读不访问 Core、写回确认前内存已更新且 `modify` 未完成、写回失败时请求失败而内存保留新值、取回失败时拒绝且不回退到环境变量（Core 恢复后自动重新取回）、推送与过期通知、两个 Agent Host 只刷新一次、两个 Agent Host 各 20 次并发修改无丢失。测试用的假 Core 与 `SecretsService` 的语义一致（锁、revision、推送）。

## 7. 多个 Agent Host 的缓存一致

| 问题 | 做法 |
|---|---|
| 一处写入后其他 Agent Host 的缓存怎么更新 | Core 把每次写入推给所有订阅者（`secrets/changed`），接收方按 `revision` 取新弃旧 |
| 两处同时刷新同一 token 怎么避免互相覆盖 | 刷新在 Core 的键锁内进行；后拿到锁的一方从锁结果里看到新 token，pi-ai 的复查判定无需刷新 |
| 推送晚于本地读 | 锁结果本身带当前值，读改写不依赖推送是否已到 |
| 持锁的 Agent Host 崩溃或卡住 | 连接结束立即释放；卡住时 30 秒租约到期释放，之后它带旧 `lockId` 的写入被拒（`secretLockLost`） |
| 锁请求超时后 Core 才授予 | 该锁无人使用，最多占用一个租约；可接受，代价是同键的下一次写入最多晚 30 秒 |

## 8. 登录与刷新的端到端验证

`crates/piarc-testkit/tests/agent_host/credentials.rs`：真实 Agent Host bundle、Core 的 `SecretsService`（保险箱文件在测试数据目录，主密钥在内存凭据库替身中）、严格 mock provider、测试内的本地 token 端点（refresh token 轮换：用过一次即失效）。Agent Host 以测试专用参数 `--test-oauth-provider` 注册一个 OAuth provider（Core 不传，`isSubscription: false`，与 Anthropic 订阅登录无关，ADR-0006），它的 `login` 与 `refresh` 访问本地端点，`toAuth` 把 token 的非机密标签放进 `x-piarc-test-token` 请求头（mock 会把凭据头脱敏，标签让测试看出每个请求用了哪一代 token）。

过程与结果：

1. Agent Host A 启动后经 `ModelRuntime.login()` 登录，凭据经 `modify` → `secrets/set` 写入保险箱（Core 的变更通道收到 `oauth/piarc-test-oauth`）。第一代 token 有效期 120 秒，低于 pi-ai 的 5 分钟刷新窗口。
2. Agent Host B（另一个工作区）启动，`secrets/getAll` 取回第一代 token。
3. A 的两个会话与 B 的一个会话同时提问。token 端点收到的请求依次为 `authorization_code`（接受）、`refresh_token`（接受），没有第二次刷新，也没有被拒的刷新；刷新请求被人为延迟 300 ms 以拉大竞争窗口。
4. 三个模型请求的 `x-piarc-test-token` 都是 `gen-2`；保险箱中 `oauth/piarc-test-oauth` 的 access、refresh 与标签都是第二代。

失败路径：内存凭据库替身拒绝访问时，Agent Host 的取回失败，会话的回合以 `failed` 结束，`errorMessage` 为 "Credential store read failed for piarc-mock: secrets/getAll failed: access to the credential store was denied: …"，mock 没有收到任何请求，数据目录中没有 `secrets.vault` 与 `auth.json`；恢复访问后下一回合完成，保险箱随之创建。

## 9. 无明文扫描与环境变量

同一个端到端测试结束时，以全部已签发的 access 与 refresh token（随机生成）为目标逐字节搜索（`piarc_testkit::plaintext`，不跟随符号链接，读不了的文件单独列出）：

| 范围 | 结果 |
|---|---|
| 测试根目录：数据目录（`secrets.vault`、`pi/` 及其会话 JSONL、`sessions/`）与两个工作区 | 12 个文件约 50 KB，0 处 |
| Core 日志（tracing 输出，含两个 Agent Host 的全部 stderr 行） | 约 7.9 KB，0 处 |
| 系统临时目录中测试开始后写入的文件 | 12 个文件，0 处，0 个读不了 |
| 对照：在 `sessions/` 下放一个含 token 的文件 | 找到 1 处（证明扫描路径有效），随后删除 |

`pi/auth.json`、`pi/mcp-auth.json` 不存在。环境变量：两个 Agent Host 进程与 A 的 MCP server 子进程用 `ps -E` 读取，都能看到 `PATH=` 而没有任何 token；Bash 工具在会话中执行 `env` 的输出（12 个变量）也没有。

## 10. 真实钥匙串

`crates/piarc-secrets/tests/system_store.rs` 用真实的登录钥匙串，服务名为 `piarc-test.a11.<pid>.<随机>.credential-vault`：首次打开保险箱生成主密钥并写入钥匙串，`security find-generic-password`（不带 `-g`、`-w`，不输出密码）确认条目存在；读回 32 字节密钥并解密保险箱；删除条目后再查不存在，保险箱返回 `masterKeyMissing`，第二次删除报告没有条目。整个过程没有出现授权提示（创建条目的就是读取它的同一个测试进程）。用例只碰 `piarc-test.` 前缀的条目，失败时也会先清理。

这组测试在 `cargo test` 中运行。凭据库不可用（无登录会话、钥匙串锁定、30 秒内没有应答）时打印 `T08-A11 NOT RUN` 与原因，设 `PIARC_REQUIRE_KEYCHAIN=1` 时改为失败；本机以该变量运行通过。Windows 的同一测试在 Windows CI 上编译并运行，替身测试与 macOS 相同。

## 11. 结论与遗留

| 项 | macOS | 待验证 |
|---|---|---|
| 保险箱格式、篡改检测、原子写入 | 通过 | — |
| 主密钥状态表与错误路径 | 通过（替身与真实登录钥匙串） | W0：Windows 凭据管理器实机 |
| 适配层与 Pi 接口契约 | 通过 | — |
| 多会话、多 Agent Host 的一致与只刷新一次 | 通过 | — |
| 无明文、环境变量无凭据 | 通过 | W0：Windows 数据目录（`%LOCALAPPDATA%\PiArc\`）扫描与进程环境检查（本测试在 Windows 上不读取其他进程的环境，打印 NOT RUN） |
| 更新后最多一次钥匙串授权 | — | T12：两次打包构建之间实测 |

其他：

- 服务名前缀依赖 D2。D2 落实后修改 `APP_IDENTIFIER`；用占位标识存过凭据的构建届时找不到主密钥，会得到 `masterKeyMissing`（`docs/plan/PLAN.md` I22）。
- JavaScript 无法清零字符串，Agent Host 内存中的凭据在进程结束前一直存在；这与架构第 5.4 节"凭据只经 AHP 传给 Agent Host"一致，Seatbelt（T39）限制 Agent Host 的其他出口。
- 日志与诊断包的自动脱敏（架构第 10.1 节）属于 `piarc-telemetry`，本任务只保证凭据值不进日志与错误信息。
