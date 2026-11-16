# 测试用发布清单密钥

这里的两对 minisign 密钥只用于测试，私钥未加密、随仓库公开，任何人都能用它们签名。

| 文件 | 用途 |
|---|---|
| `release-manifest.test.key` / `.pub` | 签名与校验发布清单的测试（`scripts/release/release-manifest.test.mjs`、`crates/piarc-core/tests/release.rs`） |
| `other.test.key` / `.pub` | "换用其他密钥签名"的反例 |

应用内置的公钥（`piarc_core::release::BUILTIN_RELEASE_KEYS`）不包含这两把测试公钥；正式密钥由 T50 在受保护的发布环境中生成和保管（ADR-0024）。重新生成：

```bash
node scripts/release/release-manifest.mjs keygen --out-dir scripts/release/test-keys --name release-manifest.test
```

重新生成后要同步重写 `crates/piarc-core/tests/fixtures/release/` 下的签名样本（见该目录的 README）。
