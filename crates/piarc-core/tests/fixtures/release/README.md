# 发布清单签名样本

`crates/piarc-core/tests/release.rs` 用这些文件验证 Core 的发布清单校验（T12-A08）。签名由 Node 的 `scripts/release/release-manifest.mjs` 生成、由 Rust 的 `minisign-verify` 校验，两套实现互相印证格式。

| 文件 | 内容 |
|---|---|
| `PiArc-0.1.0-arm64.dmg`、`PiArc-0.1.0-arm64.zip` | 两个假产物（几十字节的文本） |
| `piarc-release-manifest.json` + `.minisig` | 用 `scripts/release/test-keys/release-manifest.test.key` 签名的清单 |
| `piarc-release-manifest.json.other-key.minisig` | 同一份清单，用 `other.test.key` 签名（"换用其他密钥"的反例） |

篡改内容、篡改哈希等反例在测试中由这些文件派生，不另存。重新生成（换了测试密钥或清单格式时）：

```bash
node scripts/release/release-manifest.mjs generate --version 0.1.0 --key scripts/release/test-keys/release-manifest.test.key --out crates/piarc-core/tests/fixtures/release/piarc-release-manifest.json crates/piarc-core/tests/fixtures/release/PiArc-0.1.0-arm64.dmg crates/piarc-core/tests/fixtures/release/PiArc-0.1.0-arm64.zip
```

`other-key` 签名用同一脚本导出的 `signData` 以 `other.test.key` 对清单字节签名生成。
