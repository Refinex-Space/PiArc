# piarc-secrets

凭据保险箱：服务商 API key、OAuth token、MCP token 加密存放在 `<数据目录>/secrets.vault`（AES-256-GCM），32 字节主密钥在系统凭据库（macOS 登录钥匙串、Windows 凭据管理器，经 `keyring-core`）。ADR-0018 第 5 条、ADR-0021、`docs/spikes/S05-credential-vault.md`。不负责把凭据交给 Agent Host、锁与变更推送（`piarc-core::secrets`），不负责登录流程（Agent Host），不选择应用标识（`piarc-core::identity`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-secrets` | 格式往返、逐字节篡改、版本、状态表、凭据库替身注入、原子写入失败（`src/vault.rs` 单元测试），以及真实系统凭据库（`tests/system_store.rs`） |
| `PIARC_REQUIRE_KEYCHAIN=1 cargo test -p piarc-secrets --test system_store -- --nocapture` | 真实钥匙串必须可用，否则失败；打印 T08-A11 的证据行 |
| `cargo clippy -p piarc-secrets --all-targets -- -D warnings` | lint |

## 格式（版本 1，`src/format.rs`）

魔数 `PIARCVLT`（8）+ 版本（2，小端）+ 主密钥标识（16）+ nonce（12）+ 密文 + GCM 标签（16）。前 38 字节是附加数据。改了格式就递增 `FORMAT_VERSION`，旧版本的读取路径保留并加迁移测试；不要在版本 1 里加字段。

## 状态表（`src/vault.rs` 模块文档为准）

| 保险箱 | 主密钥 | `Vault::open` |
|---|---|---|
| 无 | 无 | 生成主密钥、写入凭据库、写空保险箱 |
| 无 | 有 | 用已有主密钥写空保险箱 |
| 有 | 有 | 认证并解密 |
| 有 | 无 | `MasterKeyMissing`：不建新密钥，不动文件 |
| 任意 | 凭据库拒绝/锁定/不可用 | `CredentialStore`（可重试）：什么都不写 |
| 被改动 / 版本未知 | 有 | `Integrity` / `UnsupportedVersion`：不返回任何条目 |

## 测试服务名约定

- 测试只在 `piarc-test.` 前缀的服务名下创建条目：用 `test_master_key_name(<标签>)`，它带 pid 与随机后缀。生产服务名是 `<应用标识>.credential-vault`，账户 `master-key`。
- 碰真实凭据库的测试放在 `tests/system_store.rs`，结束（含断言失败）时删除自己创建的条目；凭据库不可用时打印 `T08-A11 NOT RUN` 与原因，不静默通过。
- 其余测试用 `MemorySecretStore`（`fail_with` 注入拒绝、锁定、失败；`remove` 模拟用户删除条目）。

## 不变量

- **禁止打印凭据**：错误、`Debug`、日志、测试输出都不含凭据值与主密钥。错误只写键名与原因；`MasterKey` 的 `Debug` 只显示标识。查钥匙串条目只确认存在与否（`security find-generic-password` 不带 `-g`、`-w`）。
- 主密钥、明文与条目值放在 `Zeroizing` 中；序列化走 `ZeroizingWriter`（扩容时清零旧缓冲）。不要把明文放进普通 `Vec`/`String` 再拷贝。
- 内存状态只在新文件 rename 成功后改变；写入失败时回滚内存。
- 打开时先问凭据库再动文件：凭据库拒绝时不创建任何东西，不回退到明文。
- macOS 用登录钥匙串（`apple-native-keyring-store` 的 `keychain` 特性），不用 data protection keychain（ad-hoc 签名没有 provisioning profile）。
- 只依赖 `piarc-protocol` 与 `piarc-ports`；`security-framework` 只为读出 OSStatus 区分拒绝与锁定。

## 易错点

- 改版本字段的两个字节会被报告为 `UnsupportedVersion` 而不是完整性错误：版本决定如何读其余部分（A01 的测试对这两个字节单独断言）。
- keyring-core 的 `BadEncoding`/`BadDataFormat` 带着条目原始字节，映射错误时丢掉它们，不要转成字符串。
- `aes-gcm` 0.11 的 `KeyInit::new` 取 `&Array`：`key.bytes().into()`；加密用 `encrypt_inout_detached` 在原缓冲上进行。
- 测试中钥匙串调用可能因为等待授权提示而阻塞：`tests/system_store.rs` 在线程里调用并设 30 秒上限。

## 参考

- 架构第 5.4、7.1、9.1、10.1 节；ADR-0018、ADR-0021；`docs/research/native-stack.md` 第 8.4 节。
