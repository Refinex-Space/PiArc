# piarc-browser-import

从 Chrome 按站点导入登录（ADR-0090，设计增补 `docs/architecture/addenda/browser.md` B5.1–B5.4）：列出 Chrome 的配置文件，从 `Cookies` 数据库的副本读站点与条数，解密用户选中站点的 cookie，给出 Electron `cookies.set` 的形状。不问用户、不写浏览器分区、不存导入记录、不写审计、不登记脱敏（Core 的 `browser::import` 与主进程的 `main/browser/chrome-import.ts`）。

## 命令

| 命令 | 用途 |
|---|---|
| `cargo test -p piarc-browser-import` | 配置文件列表（`Local State` 与目录扫描）、数据库副本（含 WAL、缺 meta 或列）、站点计数与过期、v10 两种方案的往返、版本 24 的域哈希、错误密钥、篡改、v20 报不支持、键与明文不进 `Debug`；Windows 上另跑 DPAPI 往返与 `Local State` 密钥 |
| `cargo clippy -p piarc-browser-import --all-targets -- -D warnings` | lint；Windows 代码在 macOS 上用根 `AGENTS.md` 的交叉 clippy 命令（`-p piarc-browser-import`） |

## 方案

- macOS `v10`：钥匙串 `Chrome Safe Storage`（账户 `Chrome`）的密码经 PBKDF2-HMAC-SHA1（盐 `saltysalt`、1003 轮、16 字节）得 AES-128-CBC 密钥，IV 是 16 个空格，PKCS#7。
- Windows `v10`：`Local State` 的 `os_crypt.encrypted_key` 是 base64 的 `DPAPI` + DPAPI 密文，`CryptUnprotectData`（当前用户、不弹界面）解出 32 字节 AES-256-GCM 密钥；值是 `v10` + 12 字节 nonce + 密文 + 16 字节标签。`v20`（App-Bound）逐条报 `appBound`，不尝试。
- `meta.version` ≥ 24 时明文前 32 字节是 `host_key` 的 SHA-256：核对后去掉，不符按 `undecryptable` 跳过。
- 只读副本：`Cookies` 与 `Cookies-wal` 复制到 `<缓存目录>/chrome-import/` 下的新目录再打开，`CookieDb` 释放时删除；Windows 上 Chrome 独占文件（共享冲突 32/33）报 `locked`（可重试）。

## 不变量

- 列站点不需要密钥；导入时先打开副本、读出选中站点的行，确有加密值才向 `KeySource` 要一次密钥。数据库读不了就不会弹出钥匙串。
- 密钥、钥匙串密码、加密值与明文都放在 `Zeroizing` 里；`ChromeKey`、`RawCookie`、`Cookie` 的 `Debug` 不含它们，错误信息只写路径、配置文件名与原因（SQLite 的错误不含行值）。
- 测试与开发构建的 L4 用 `FixedKey(test_key())`（`TEST_PASSWORD` 按平台方案派生），不碰本机的钥匙串与 Chrome；`cookies::fixture` 写 Chrome 同构的数据库，`crypto::seal` 是 `open` 的逆运算。
- `unsafe` 只在 Windows 的 `dpapi` 模块（编码规范 2.8），每块前写 `// SAFETY:`。

## 易错点

- 站点按 `host_key` 去掉前导点分组（`github.com` 与 `.github.com` 同一组，`gist.github.com` 另一组）；导入站点对智能体是敏感的，判断用 `covered`（站点本身与子域名），主进程的 `chrome-import.ts` 与 Core 的 `browser::import::is_imported` 用同一规则。
- Chrome 的时间是 1601 年起的微秒（`cookies::unix_seconds`）；`expires_utc` 为 0 或 `is_persistent` 为 0 的是会话 cookie，不算过期。
- 分区 cookie（`top_frame_site_key` 非空）按 `partitioned` 跳过：`cookies.set` 不能带分区键。
