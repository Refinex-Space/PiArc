# 发布规范

- 适用范围：PiArc 桌面应用在 GitHub Releases 上的正式版与预发布版
- 相关：[ADR-0018](../adr/0018-unsigned-distribution.md)（不做平台签名）、[ADR-0024](../adr/0024-release-manifest-format.md)（发布清单）、[ADR-0111](../adr/0111-in-app-updates.md)（应用内更新与产物命名）；架构第 13 章
- 工具：`scripts/release/`（版本、更新日志、产物整理、清单签名）、`.github/workflows/release.yml`

一次发布是一个 `v<版本>` 标签。标签推送后，Release 工作流在四个目标上构建发布版、按 ADR-0111 的名字整理产物、生成更新说明、在受保护的 `release` 环境里签名清单，最后建一个**草稿** Release。维护者装机冒烟后手动发布。应用只从"最新正式版"检查更新，所以草稿和预发布版不会推给用户。

## 1. 原则

- **版本只增不复用。** 发出去的版本号、标签和产物永远不改、不重用；有问题就发下一个补丁版本。
- **构建只在 CI。** 发布产物只来自 Release 工作流，本机构建的包不上传。
- **签名私钥只在 `release` 环境。** 工作流的其他作业、PR 与 fork 都拿不到它。
- **两份更新日志同步。** 英文与简体中文列出相同的版本、相同的条目，应用按界面语言显示其中一份。
- **先草稿，后发布。** 发布前在两个平台上各装一次草稿里的安装包。

## 2. 版本号

- 遵循 SemVer：`MAJOR.MINOR.PATCH`，预发布加 `-beta.N` 或 `-rc.N`，不用构建元数据（`+…`）。
  - PATCH：修复与安全更新，不改变设置与数据格式；
  - MINOR：新功能，兼容已有的设置、会话与数据目录；
  - MAJOR：需要用户处理的不兼容变化（数据迁移不可回退、去掉功能、系统要求提高）。
- 应用版本的唯一来源是 `apps/desktop/package.json` 的 `version`（主进程 `app.getVersion()`、安装包文件名、Velopack 版本都取它），`package-lock.json` 里 `apps/desktop` 一项与之相同。`node scripts/release/version.mjs set <版本>` 同时改这两处，不要手改。
- crate、Agent Host 与 AHP 协议的版本独立维护，不跟随应用版本（架构第 13.4 节）。
- 标签是 `v<版本>`，打在合入 `main`（或第 4 节的维护分支）的提交上。`version.mjs check --tag` 核对标签与 `package.json` 一致。
- 预发布版（版本里有 `-`）由工作流标成 Pre-release。GitHub 的 `releases/latest` 不指向预发布版，应用不会把它当作更新。

## 3. 更新日志

两份文件：根目录的 `CHANGELOG.md`（英文）与 `CHANGELOG.zh-CN.md`（简体中文），格式为 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)。每个版本的那一节就是应用"关于"页与更新提示里显示的更新说明（`piarc-release-notes.json`），也是 GitHub Release 的正文。

### 3.1 结构

```markdown
## [Unreleased]

### Added
- …

## [1.1.0] - 2027-01-15

### Fixed
- …

[Unreleased]: https://github.com/Refinex-Space/PiArc/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Refinex-Space/PiArc/compare/v1.0.0...v1.1.0
```

- 版本标题写成 `## [版本] - YYYY-MM-DD`，两份文件的版本与日期相同。
- 小节只用下表的名字，按表中顺序，没有内容的小节不写：

  | CHANGELOG.md | CHANGELOG.zh-CN.md | 写什么 |
  |---|---|---|
  | `### Added` | `### 新增` | 新功能 |
  | `### Changed` | `### 变更` | 已有功能的行为变化 |
  | `### Deprecated` | `### 弃用` | 即将移除的功能 |
  | `### Removed` | `### 移除` | 已移除的功能 |
  | `### Fixed` | `### 修复` | 缺陷修复 |
  | `### Security` | `### 安全` | 安全修复与安全相关的依赖升级 |

- **安全更新的判定**：一个版本有 `### Security`（中文版 `### 安全`）小节，它就是安全更新，`piarc-release-notes.json` 的 `security` 为 `true`，应用把更新标为"安全更新"（ADR-0018 第 8 条），Release 正文顶部加提示。两份文件必须同时有或同时没有这一节，否则 `version.mjs check` 失败。
- 平时把条目写在 `## [Unreleased]` 下，随功能 PR 一起提交。发布时 `version.mjs set` 把它移进带日期的新版本一节，并更新文末的比较链接。

### 3.2 写法

- 写给用户：说用户能看到的变化和影响，不写内部任务号（T48、W1）、提交哈希、重构与测试。
- 一条一行，以 `- ` 开头；关联的 issue 或 PR 写在句末，如 `(#123)`。
- 两份文件条目一一对应、顺序相同。
- 只用 Markdown 的标题、列表、强调、行内代码和 https 链接：应用内用 `MarkdownView` 渲染，原始 HTML 按文本显示，链接点击要经确认。
- 依赖升级只在影响用户时写（Electron、Node、Pi 的大版本，或修复了安全问题）。

## 4. 分支与标签

- 日常开发在短期分支，合入 `main`；发布从 `main` 打标签。
- 发版前的版本号改动走 PR：分支 `chore/release-<版本>`，提交信息 `chore(release): <版本>`。
- 需要在旧版本线上出补丁而 `main` 已有未准备好的改动时，从该版本的标签切 `release/<主版本>.<次版本>`（例如 `release/1.0`），只拣选修复，在这个分支上 `version.mjs set` 并打标签。发布后把这一版的更新日志合回 `main`，保证 `main` 的两份文件包含所有发出的版本。
- 标签用带注释的标签：`git tag -a v1.0.1 -m "PiArc 1.0.1"`。标签推送后不移动、不删除（第 6 节的规则集会拦截）。

## 5. 发布清单

### 5.1 发版前

- [ ] `main` 上 CI 全绿：两个平台的 `verify`、`desktop L4`、`core build`、`package macOS`、`package Windows`。
- [ ] 本机在要发布的提交上 `npm run verify` 全部通过，工作区干净。
- [ ] 最近一次 Perf Nightly 没有超预算或回归，L3 Nightly 通过。
- [ ] `npm run audit:deps` 没有未登记的公告；Electron 大版本仍在官方支持期内（架构第 13.4 节）。
- [ ] `node scripts/ci/check-capabilities.mjs` 通过，`docs/product/capabilities.md` 没有漂移。
- [ ] `## [Unreleased]` 的两份内容完整、一致，读起来是给用户看的。

### 5.2 改版本号

```bash
git switch -c chore/release-1.1.0 main
node scripts/release/version.mjs set 1.1.0        # 日期缺省为当天（UTC），可加 --date YYYY-MM-DD
node scripts/release/version.mjs check            # 打印 1.1.0 即通过
npm run verify
git commit -am "chore(release): 1.1.0"
```

开 PR。合入前在 Actions 里对这个分支手动运行 **Release** 工作流（`workflow_dispatch`）做一次演练：它走完全部构建与整理，用测试密钥签名并校验，结果作为工件 `release-<版本>` 上传，不建 Release。下载工件，核对第 9 节的 13 个文件。

### 5.3 打标签

```bash
git switch main && git pull --ff-only
git tag -a v1.1.0 -m "PiArc 1.1.0"
git push origin v1.1.0
```

工作流依次运行 `check`、四个打包作业、`assemble`，最后 `publish` 等待 `release` 环境的审批。确认前面的作业全部通过后，在运行页面点 **Review deployments → release → Approve and deploy**。`publish` 签名清单、用仓库里的公钥校验每个文件，然后建草稿 Release。

### 5.4 审阅草稿

- [ ] 草稿的文件是第 9 节的 13 个，名字带正确版本号；正文的两种语言、下载表与校验命令正确。
- [ ] 本机校验：下载 `piarc-release-manifest.json` 与 `.minisig`，`minisign -Vm piarc-release-manifest.json -p scripts/release/piarc-release.pub`。
- [ ] macOS（开着 Gatekeeper 的机器，`spctl --status` 为 `assessments enabled`）：DMG 拖进"应用程序"，首次打开按 README 的放行步骤，引导页连上模型，跑一轮会话；"设置 → 关于"显示新版本。
- [ ] Windows 11：运行 Setup，SmartScreen 选"仍要运行"，同样跑一轮会话并看"关于"页。
- [ ] Defender：工作流已对安装包扫描。没有扫描结果（作业里没有 `MpCmdRun.exe`）时，在 Windows 上手动运行 `"%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File <Setup.exe>`；误报时到 Microsoft Security Intelligence 提交样本（ADR-0018 第 3 条）。
- [ ] 已装上一版本的机器在草稿阶段检查更新应显示"已是最新版本"（草稿不可见）；更新路径在发布后按第 5.6 节验证。

### 5.5 发布

在草稿页编辑：正式版勾选 **Set as the latest release**，预发布版保持 **Set as a pre-release**；点 **Publish release**。

### 5.6 发布后

- [ ] `https://github.com/Refinex-Space/PiArc/releases/latest/download/piarc-release-manifest.json` 下载到的是新版本的清单。
- [ ] 两个平台各用一台装着上一版本的机器：设置 → 代理选"手动设置"并指向一个本地代理（例如 mitmproxy 的普通代理模式），"关于"页检查更新、下载、重启以更新；代理日志里出现 `CONNECT github.com:443` 与 `CONNECT release-assets.githubusercontent.com:443`，重启后"关于"页显示新版本。
- [ ] README 的下载说明与新版本一致；有需要时在 issue 或讨论区公告。

## 6. GitHub 一次性配置

<!-- release-environment -->

在仓库的 **Settings** 中完成，之后每次发布都不用再改。

| 位置 | 设置 | 目的 |
|---|---|---|
| Environments → New environment | 名称 `release` | `publish` 作业只在这个环境里运行 |
| `release` → Deployment protection rules | 勾选 **Required reviewers**，加入维护者；单人维护时不要勾 Prevent self-review | 签名前必须有人批准 |
| `release` → Deployment branches and tags | 选 **Selected branches and tags**，**Add deployment branch or tag rule** → Ref type 选 Tag，名称模式 `v*` | 只有 `v*` 标签能进入这个环境 |
| `release` → Environment secrets | **Add environment secret**：名称 `PIARC_RELEASE_SIGNING_KEY`，值为发布私钥文件 `piarc-release.key` 的完整内容（两行，含 `untrusted comment:` 一行） | 清单签名私钥 |
| Rules → Rulesets → New tag ruleset | 名称 `release tags`，Enforcement 为 Active，目标 **Include by pattern** `v*`；勾选 Restrict creations、Restrict updates、Restrict deletions、Block force pushes；Bypass list 加 Repository admin | 只有维护者能打发布标签，标签推送后不能移动或删除 |
| Rules → Rulesets → New branch ruleset | 目标 `main`（Default branch）；勾选 Restrict deletions、Require a pull request before merging、Require status checks to pass（`verify (macos-latest)`、`verify (windows-latest)`、`desktop L4 (macos-latest)`、`desktop L4 (windows-latest)`）、Block force pushes | `main` 始终可构建 |
| Actions → General → Workflow permissions | 选 **Read repository contents and packages permissions**，不勾 Allow GitHub Actions to create and approve pull requests | 默认只读；`publish` 作业自己声明 `contents: write` |

## 7. 发布签名密钥

清单签名用项目自有的 Ed25519 密钥，minisign 格式（ADR-0024）。应用内置公钥，用它验签后才下载与安装更新（ADR-0111）。

### 7.1 生成（只做一次）

在维护者自己的电脑上、仓库目录之外生成：

```bash
node scripts/release/release-manifest.mjs keygen --out-dir ~/piarc-release-key --name piarc-release
```

得到 `piarc-release.key`（私钥，权限 600，未加密）与 `piarc-release.pub`（公钥）。

1. 私钥：内容填进第 6 节的环境密钥 `PIARC_RELEASE_SIGNING_KEY`；另存一份离线备份（密码管理器的安全附件，或加密的移动存储），然后删除电脑上的副本。私钥不进仓库、聊天记录与 CI 日志。
2. 公钥：
   - 复制到仓库 `scripts/release/piarc-release.pub` 提交。`publish` 作业用它校验刚做的签名，私钥填错会在这一步失败，而不是在用户的应用里失败；
   - 第二行（以 `RW` 开头的 base64）写进 `crates/piarc-core/src/release.rs` 的 `BUILTIN_RELEASE_KEYS`，这一处为空时应用拒绝一切清单（ADR-0024 第 5 条）；
   - 同一行写进 README 与 README.zh-CN 的"校验下载"一节。
3. 这三处改动一起提交，例如 `feat(release): trust the release signing key`，经 PR 合入后才能打第一个标签。

### 7.2 轮换

- **计划轮换**：生成新密钥；新旧两把公钥同时写进 `BUILTIN_RELEASE_KEYS` 发一个版本（仍用旧私钥签名）；大多数用户升级后，把环境密钥换成新私钥、`piarc-release.pub` 换成新公钥，下一个版本起用新私钥签名；再过一个版本移除旧公钥。只装着轮换前版本的用户无法验证新签名，需要手动下载安装。
- **私钥泄露**：按安全事件处理（`SECURITY.md`）。立即删除环境密钥；用新密钥发一个只信任新公钥的版本；在 Release 页面与 README 公告，说明旧版本用户需要手动下载安装，并给出新公钥。

## 8. 安全更新

- Electron、Chromium、Node 出现在野利用的高危漏洞，或 PiArc 自身的安全问题修复后，立即发补丁版本（架构第 13.4 节）。
- 更新日志写 `### Security` / `### 安全` 小节，应用里的更新提示带"安全更新"标记。
- 涉及未公开漏洞时，修复先在私有分支或 GitHub Security Advisory 的临时 fork 中完成，Release 发布后再公开细节（`SECURITY.md`）。

## 9. 产物

一个版本的 Release 有 13 个文件，名字由 ADR-0111 第 1 条规定，`collect-artifacts.mjs` 负责改名与核对：

| 文件 | 说明 |
|---|---|
| `piarc-release-manifest.json`、`piarc-release-manifest.json.minisig` | 签名清单，列出下面 11 个文件的大小与 SHA-256 |
| `piarc-release-notes.json` | 应用内显示的更新说明（第 3 节） |
| `PiArc-<版本>-macos-arm64.dmg`、`PiArc-<版本>-macos-x64.dmg` | macOS 手动安装 |
| `PiArc-<版本>-macos-arm64.zip`、`PiArc-<版本>-macos-x64.zip` | macOS 应用内更新 |
| `PiArc-<版本>-windows-x64-Setup.exe`、`PiArc-<版本>-windows-arm64-Setup.exe` | Windows 首次安装 |
| `releases.win-x64.json`、`releases.win-arm64.json` 与各自列出的 Full `.nupkg` | Windows 应用内更新（Velopack 的原始文件名） |

本地复现工作流里的整理与签名（用测试密钥）：

```bash
node scripts/release/collect-artifacts.mjs --version <v> --from <下载的构建工件> --out <发布目录>
node scripts/release/release-notes.mjs --version <v> --notes <发布目录>/piarc-release-notes.json --body release-body.md
node scripts/release/release-manifest.mjs generate --version <v> \
  --key scripts/release/test-keys/release-manifest.test.key \
  --out <发布目录>/piarc-release-manifest.json <发布目录>/*
node scripts/release/release-manifest.mjs verify --pub scripts/release/test-keys/release-manifest.test.pub \
  --files-dir <发布目录> <发布目录>/piarc-release-manifest.json
```

## 10. 撤回有问题的版本

- 发布后发现严重问题：在 Release 页面编辑这个版本，改为 **Set as a pre-release**（不删除）。`releases/latest` 随即回到上一个正式版，还没升级的用户不会再收到它。
- 已经升级的用户不会被降级：应用只提示更高的版本。尽快修复并发下一个补丁版本，它会提示给所有人。
- 产物本身有害（被篡改、带恶意代码）时，再删除这个 Release 的全部文件，并按安全事件处理；标签保留，版本号不再使用。

## 11. 首次发布 1.0.0 步骤

按顺序完成。标"GitHub"的在网页上操作，标"本机"的在仓库根目录运行。

1. **本机：生成发布密钥**（第 7.1 节）

   ```bash
   node scripts/release/release-manifest.mjs keygen --out-dir ~/piarc-release-key --name piarc-release
   cat ~/piarc-release-key/piarc-release.pub
   ```

2. **GitHub：建 `release` 环境**（第 6 节前四行）：Required reviewers 加自己；Deployment branches and tags 只放 `v*` 标签；环境密钥 `PIARC_RELEASE_SIGNING_KEY` 填 `piarc-release.key` 的完整内容。之后把私钥备份到离线位置，删除本机副本。
3. **GitHub：建规则集**（第 6 节第五、六行）：`v*` 标签规则集与 `main` 分支规则集。
4. **GitHub：Actions 权限**（第 6 节最后一行）：默认只读。
5. **本机：信任发布公钥**（第 7.1 节第 2、3 条）：提交 `scripts/release/piarc-release.pub`，把公钥行写进 `BUILTIN_RELEASE_KEYS` 与两份 README，运行 `npm run build:core -- --flavor all` 和 `npm run verify`，经 PR 合入 `main`。
6. **本机：改版本号**（第 5.2 节）

   ```bash
   git switch -c chore/release-1.0.0 main
   node scripts/release/version.mjs set 1.0.0
   node scripts/release/version.mjs check
   npm run verify
   git commit -am "chore(release): 1.0.0"
   git push -u origin chore/release-1.0.0
   ```

   开 PR。
7. **GitHub：演练**：Actions → **Release** → **Run workflow**，分支选 `chore/release-1.0.0`。完成后下载工件 `release-1.0.0`，核对 13 个文件（演练的签名是测试密钥）。有问题就在这个分支上修，再演练。
8. **GitHub：合入 PR**，确认 `main` 上的 CI 全绿。
9. **本机：打标签**

   ```bash
   git switch main && git pull --ff-only
   git tag -a v1.0.0 -m "PiArc 1.0.0"
   git push origin v1.0.0
   ```

10. **GitHub：批准签名**：Actions 里这次 Release 运行到 `publish` 时，点 **Review deployments**，勾 `release`，**Approve and deploy**。
11. **GitHub + 两台测试机：审阅草稿**（第 5.4 节）。1.0.0 没有上一个版本，更新路径在第一个补丁版本时按第 5.6 节验证；这次只确认"关于"页检查更新显示"已是最新版本"。
12. **GitHub：发布**：勾 **Set as the latest release**，**Publish release**。
13. **发布后**（第 5.6 节第一、三项）：确认 `releases/latest/download/piarc-release-manifest.json` 指向 1.0.0。
