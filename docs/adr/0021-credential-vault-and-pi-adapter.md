# 0021. 凭据保险箱的格式、并发与 Pi 凭据接口适配（补充）

- 状态：已接受（补充 ADR-0018 第 5 条，T08）
- 日期：2026-11-15
- 取代：无
- 相关：架构文档第 5.4、7.1、7.4、9.1、10.1 节；ADR-0006、ADR-0009、ADR-0018；`docs/spikes/S05-credential-vault.md`

## 背景

ADR-0018 第 5 条决定：服务商 API key、OAuth token、MCP token 加密存放在数据目录下的保险箱文件中，系统凭据库只存一个主密钥。架构第 5.4 节给出 Agent Host 侧的做法：启动时向 Core 一次性取回凭据放在内存，写操作异步回写 Core。没有定下来的是：文件格式、主密钥丢失与凭据库拒绝时怎么办、多个 Agent Host（每个工作区一个，ADR-0010）同时缓存凭据时怎么保持一致，以及两个 Agent Host 同时刷新同一个 OAuth token 时怎么避免互相覆盖。

T08 核对 Pi 1.5.2 的锁定版本得到两条事实：

- `ModelRuntime.create({ credentials })` 接受的是 pi-ai 的 `CredentialStore`（`@earendil-works/pi-ai` `dist/auth/types.d.ts`），四个方法 `read`、`list`、`modify`、`delete` 都返回 Promise。架构第 5.4 节提到的同步接口 `AuthStorageBackend.withLock` 只属于 coding-agent 的 `AuthStorage`（`auth.json` 后端），PiArc 不走那条路径。风险 R11（同步接口对异步凭据库）在这个注入点不出现。
- pi-ai 在 `modify` 内完成 OAuth 刷新（`dist/auth/resolve.js` 的 `refreshStoredOAuthCredential`）：剩余有效期不到 5 分钟时刷新，刷新超时 15 秒；接口约定要求同一 provider 的修改互斥，"后端支持时跨进程也互斥"，并在释放锁之前把刷新结果持久化。服务商的 refresh token 常常一次性有效，两个进程各刷新一次会让其中一个拿到失效的 token。

## 决策

1. **文件格式**：`<数据目录>/secrets.vault`，版本 1：魔数 `PIARCVLT`、2 字节格式版本、16 字节主密钥标识、12 字节随机 nonce、密文、16 字节 GCM 标签。前 38 字节头部是 AES-256-GCM 的附加数据，改动头部、nonce、密文或标签的任一字节都无法解密；每次写入换新 nonce；写入经同目录临时文件、`fsync` 与 rename 原子替换。明文是 JSON：`凭据键 → { revision, updatedAt, value }`，`revision` 取自保险箱级的递增计数，删除也消耗一个。加密库用 RustCrypto 的 `aes-gcm` 0.11.1。
2. **主密钥**：32 字节随机数，经 `piarc-ports::SecretStore` 存取；生产实现用 `keyring-core` 1.0.1：macOS 为登录钥匙串（`apple-native-keyring-store` 1.0.2 的 `keychain` 模块），不用 data protection keychain（它的 access group 需要 provisioning profile，ad-hoc 签名的构建没有）；Windows 为凭据管理器（`windows-native-keyring-store` 1.1.0）。服务名 `<应用标识>.credential-vault`，账户 `master-key`；应用标识集中定义在 `piarc-core::identity`。主密钥标识是 SHA-256(域标签 ‖ 密钥) 的前 16 字节。
3. **状态与错误**：没有保险箱也没有主密钥时生成两者；有保险箱、没有主密钥时返回 `masterKeyMissing`，不新建密钥、不改文件；凭据库拒绝、锁定或不可用时返回可重试的 `credentialStoreUnavailable`，什么都不写；认证失败返回 `vaultIntegrity`，版本未知返回 `vaultVersion`，都不返回任何条目。Core 在下一次请求时重新尝试打开，用户授权后无需重启。
4. **AHP**：Agent Host → Core 的 `secrets/getAll`、`secrets/get`、`secrets/set`、`secrets/delete`、`secrets/lock`、`secrets/unlock`，Core → Agent Host 的通知 `secrets/changed`。Core 是保险箱唯一的写入方，所有 Agent Host 共用 Core 中的一个 `SecretsService`。
5. **缓存一致**：调用过 `secrets/getAll` 的连接被登记为订阅者，每次写入都以 `secrets/changed` 推给所有订阅者（含写入者自己），带 `revision`；接收方只接受比已知更新的 revision。
6. **跨 Agent Host 的互斥**：一次读改写先 `secrets/lock` 该 provider 的全部键（`provider/<id>`、`oauth/<id>`），锁的结果带这些键的当前值；持锁期间其他锁请求与未持锁的写入都等待。锁在 `secrets/unlock`、租约到期（30 秒，长于 pi-ai 的 15 秒刷新超时）或持有者的连接结束时释放；拿着失效的锁写入返回 `secretLockLost`。第二个 Agent Host 拿到锁时看到的是第一个刚刷新的 token，pi-ai 在锁内的复查判定无需刷新，于是只刷新一次。
7. **Agent Host 适配层**（`agent-host/src/runtime/credentials.ts`）：实现 pi-ai 的 `CredentialStore`。`read`、`list` 从内存返回；`modify`、`delete` 按 provider 串行，在 Core 的锁内运行，先更新内存再写回 Core，等 Core 存好后才完成。写回失败时 `modify` 拒绝：pi-ai 把它变成该次模型请求的失败，会话以 `turn/completed` 的 `failed` 报出；新值留在内存里，因为轮换后的 refresh token 只存在于那里。启动时取回失败也一样：之后每个需要凭据的操作重试一次取回，仍失败就拒绝，不回退到明文或环境变量。
8. **键的映射**：pi-ai 每个 provider 一个凭据；API key 存在 `provider/<id>`，OAuth 凭据存在 `oauth/<id>`，写入其中一个时删除另一个。`mcp/<server>` 留给 T36。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 写回不等 Core 确认，`modify` 更新内存后立即完成 | 请求少等一次 AHP 往返（本机 p95 约 0.2 ms，T07-A10） | 写回失败与当前请求脱钩，只能另找途径报告；pi-ai 要求释放锁前持久化，进程在确认前退出会丢掉轮换后的 refresh token | 否 |
| 只用条件写（`expectedRevision`），冲突时重读重试 | 不需要锁表与租约 | 冲突在刷新之后才发现，两个 Agent Host 已经各刷新了一次；一次性 refresh token 会让其中一次失败或使整组 token 失效 | 否 |
| 每个 Agent Host 各自读写保险箱文件，用文件锁互斥 | 不需要 AHP 方法 | 主密钥要交给 Agent Host（违背第 5.4 节"凭据持久化在 Core"）；Agent Host 将来在 Seatbelt 下运行，对数据目录的写入受限 | 否 |
| 每条凭据一个系统凭据库条目 | 不需要保险箱文件 | ADR-0018 已否决：ad-hoc 签名的构建每次更新后每个条目弹一次授权；Windows 单条 2,560 字节上限 | 否（ADR-0018） |

## 后果

- 正面：磁盘上只有密文；一次更新最多一次钥匙串授权（只有主密钥一个条目，T12 实测）；两个 Agent Host 同时刷新同一个 token 只刷新一次；凭据库拒绝或主密钥丢失时有可区分的结构化错误，界面可以给出对应提示。
- 负面与代价：`modify` 多两次 AHP 往返（加锁、解锁）；持锁的 Agent Host 卡住时，其他 Agent Host 最多等一个租约（30 秒）；适配层不能清零 JavaScript 字符串，内存中的凭据只在 Core 侧清零。
- 需要配套做的事：D2 落实后把 `piarc-core::identity::APP_IDENTIFIER` 改为正式应用标识，并为已用占位标识存过凭据的开发构建提供迁移或重新登录提示（登记事项 I22）；T12 实测两次构建之间的钥匙串弹窗次数；W0 在 Windows 实机验证凭据管理器与数据目录扫描；T21 的设置界面与 T29 的登录流程经 `ModelRuntime` 写入，不直接调用 `secrets/*`；T36 接入 `mcp/<server>`。

## 重新评估的触发条件

出现以下任一情况时复核本决策：

- Pi 的凭据注入点改变（例如 `ModelRuntime.create` 不再接受 `CredentialStore`，或 `modify` 的调用约定变化）；
- 实测一次更新后出现多于一次的钥匙串授权，或用户拒绝授权后无法恢复；
- 出现需要在 Agent Host 之外读写凭据的进程（例如独立的 MCP 认证服务）；
- 保险箱条目数或单条大小增长到整文件重写成为瓶颈（单次写入超过 10 ms）。
