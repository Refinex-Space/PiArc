# 测试用发布清单密钥

这里的两对 minisign 密钥只用于测试，私钥未加密、随仓库公开，任何人都能用它们签名。

| 文件 | 用途 |
|---|---|
| `release-manifest.test.key` / `.pub` | 签名与校验发布清单的测试（`scripts/release/release-manifest.test.mjs`、`crates/piarc-core/tests/release.rs`） |
| `other.test.key` / `.pub` | "换用其他密钥签名"的反例 |

应用内置的公钥（`piarc_core::release::BUILTIN_RELEASE_KEYS`）不包含这两把测试公钥。正式密钥的生成与保管见 `docs/engineering/release.md` 第 7 节：私钥只在 GitHub `release` 环境的密钥里，公钥是 `scripts/release/piarc-release.pub`。Release 工作流的演练（`workflow_dispatch`）用这里的测试密钥签名。重新生成：

```bash
node scripts/release/release-manifest.mjs keygen --out-dir scripts/release/test-keys --name release-manifest.test
```

重新生成后要同步重写 `crates/piarc-core/tests/fixtures/release/` 下的签名样本（见该目录的 README）。
