# 0045. WebFetch、服务商登录、每模型设置与辅助模型的落地（补充）

- 状态：已接受，补充 ADR-0004、ADR-0006、ADR-0021、ADR-0032
- 日期：2026-11-19
- 相关：架构第 5.4、6.1.1、6.1.4、6.2.2、6.13、7.1、7.4、8.2、10.1 节；T29

## 背景

架构给出了 WebFetch 的流程（本地抓取 → Markdown → 辅助模型按提示提取）、`WebFetch(domain:…)` 规则、OAuth 与设备码登录经 `ModelRuntime.login` 的 `interaction` 回调交给客户端、每模型设置的四个字段、低可靠性模型的保守 Tool Profile 与 transcript 三档视图，但没有规定：抓取在哪个进程、用什么 HTTP 与 TLS 实现；SSRF 检查怎样防 DNS 重绑定；规则匹配的主机与实际连接的主机怎样保证一致；登录交互怎样到达客户端、怎样取消；每模型设置与辅助模型存在哪里、怎样到达 Agent Host、从哪些点生效；"低可靠性"的来源；Profile 在模型切换后怎样生效；三档视图的默认档。

## 决策

1. **抓取在 Core，新增功能 crate `piarc-web`。** 沿用 ADR-0004 第 3 条：Agent Host 的 WebFetch 工具经新 AHP 方法 `web/fetch`（能力 `webFetch`）请 Core 抓取，SSRF 检查、上限与审计都在实际发起连接的 Core 一侧。`piarc-web` 只依赖基础层，内容：HTTP/1.1（hyper 客户端）、TLS 用 rustls（ring 加密实现）加 `rustls-platform-verifier`（系统信任库，企业根证书照常生效）、HTML 转 Markdown 用 htmd（Apache-2.0，基于 html5ever），跳过 `script`、`style`、`head` 等不属于正文的元素；文本类型按字符集解码，二进制类型拒绝；请求 `Accept-Encoding: identity`，服务器仍压缩时报不支持。
2. **SSRF 检查是纯函数，连接钉住已检查的地址。** `piarc_web::ssrf::check(host, addresses, allowlist)`：解析结果中任何一个地址属于回环、私有（含 IPv6 ULA 与已废弃的 site-local）、链路本地、组播、未指定、广播或保留网段（CGNAT、文档与基准网段、240/4 等），整个主机被拒；IPv4 映射、IPv4 兼容、NAT64、6to4 形式按内嵌的 IPv4 判断。随后只连接这批已检查的地址，不再解析，所以 DNS 重绑定换不了目标；每次同站重定向重新解析并检查。允许列表（主机名精确匹配或 IP / CIDR）只来自 `CoreConfig.web`：测试服务器靠它放行；不读项目设置，仓库不能借它打开内网。
3. **授权绑定与重定向。** `web/fetch` 必须带 `origin` 指向一个已获准的 WebFetch 调用，且 URL 与该调用参数中的 `url` 完全相同；一次批准只能抓取一次（grant 被消费）。同站（同主机同端口，或同主机 http→https 的默认端口升级）的重定向在同一次抓取中跟随，至多 10 次；跨站重定向不跟随，结果带目标地址，模型要读就再发一次 WebFetch，重新经过权限裁决。规则匹配的主机（`assess` 与 hooks matcher）与抓取都用 `piarc_web::rule_host` 解析同一个 URL，不会出现"规则看到 A、实际连到 B"。URL 解析不出主机时不提供"总是允许"规则（裸 `WebFetch` 会放行所有域名）。每次抓取写一条 `kind: "webFetch"` 的审计。
4. **上限集中在 `piarc_web::FetchLimits`。** 响应体 10 MiB（超出截断并标记）、转换后正文 100,000 字符（官方参考值，超出截断并告诉提取模型）、总时长 60 s（含全部重定向，超时报错）、重定向 10 次。经 `CoreConfig.web` 可改。
5. **辅助模型通道。** `agent-host/src/harness/auxiliary.ts` 的 `AuxiliaryModel.complete`：一次不带工具、不带对话、不写缓存的模型调用，经会话的流函数发出（凭据、服务商策略与错误脱敏与其他请求相同），按会话的重试设置重试。模型取用户设置的"辅助模型"，未设置或其服务商没有凭据时用会话模型。用量计入正在运行的回合（`turn/usage` 与 `turn/completed`），并写分支条目 `piarc.auxiliaryUsage`（模型不可见，留给 T41 的成本统计）。WebFetch 的提取提示自写（`harness/prompts/web-fetch.ts`），网页作为提问里的材料，结果是工具结果，不进入 system prompt。
6. **登录在设置 Host 上运行，交互经 `core/login` 到客户端。** AHP 新增 `models/login/start`（结束时才应答）、`models/login/cancel`、`models/logout` 与 Agent Host → Core 的 `ui/loginInteraction`（能力 `login`）。Agent Host 把 Pi `AuthInteraction` 的 `notify`（授权 URL、设备码、进度、说明）与 `prompt`（文本、密文、选择、手工粘贴的代码）转成 `ui/loginInteraction`；Core 一次只运行一个登录，把每一步发到事件路由 `core/login`，客户端的答复经 Core API `answerLogin(loginId, value)` 回到等待中的请求，`value` 为空即取消。新的提问顶替屏幕上的提问（被顶替的答 `cancelled`），进度与说明不顶替（流程可能同时等待回环回调与手工粘贴）。授权页由客户端经主进程的外链确认交给系统浏览器；回调由服务商流程自己在 Agent Host 内的回环端口接收。凭据经 `CoreCredentialStore` 写入保险箱（ADR-0021），不进事件、日志与磁盘明文。等待上限 15 分钟。Pi 的 OAuth 流程模块经 `registerLazyOAuthFlows` 打进 bundle；Anthropic 的订阅 OAuth 仍在 `providers/policy.ts` 中移除并拒绝（ADR-0006），可登录服务商列表（`models/list` 的 `loginProviders`）因此不含它。
7. **每模型设置与辅助模型存在用户级设置，随握手与 `models/reload` 到达 Agent Host。** 写在用户级 `settings.json` 的 `modelProviders.models`（键为 `<服务商>/<模型 id>`，字段 `displayName`、`contextWindow`、`vision`、`defaultEffort`、`toolProfile`）与 `modelProviders.auxiliary`，只能经 Core API `setModelPreferences` 修改（校验范围）。Core 把它们组装为 `ModelPreferences`，在 `core/welcome` 与 `models/reload` 中交给每个工作区的 Agent Host。生效点：显示名进 `models/list`；上下文窗口替换压缩阈值公式中的模型窗口（ADR-0043 的 `contextWindowOverride`）与用量环；关闭图片输入后 `models/list` 的 `vision` 为假（输入框拒绝图片），Agent Host 的输入检查与请求策略也拒绝；默认 effort 在 `session/setModel` 未指定档位时应用。
8. **低可靠性与保守 Tool Profile。** 工具调用可靠性新增等级 `low`。目前的来源是服务商类型：无密钥的本地端点（`local`）的模型由 Core 标记为 `low`（本地小模型调用工具常常不可靠）；用户可在每模型设置中选"默认"或"保守"覆盖。保守 Profile 只保留 Read、Write、Edit、Bash、PowerShell、Glob、Grep、TodoWrite（MCP 与扩展工具照留），这些工具的描述换成逐步写明参数与用法的版本，名称仍是规范名，权限规则与 hooks 照常按规范名匹配；任务清单提醒提前到 3 轮工具调用，且没有清单时也提醒建立。Profile 在会话打开时按其模型决定（指定的模型，或分支上记录的模型；预测不准时立即按实际模型重开）；切换到另一档 Profile 的模型、或偏好改变了当前模型的 Profile 时，会话在空闲时于同一 id 下重开（沿用 ADR-0044 第 6 条的重开，不触发 hooks）。已冻结的 system prompt 不改写（ADR-0043），因此其中的工具指引仍是会话开始时的。
9. **三档视图只在客户端。** 普通档隐藏思考块，工具折叠为摘要；思考档显示折叠的思考块（T19 起的行为，作为默认档，不改变既有会话的显示）；详细档全部展开并显示 T27 的 `reminder` 条目。选择按会话记在渲染进程内存中，详细档的展开状态与其他档分开保存。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 抓取放在 Agent Host（Node 自带 TLS 与 `fetch`） | 不新增 Rust TLS 依赖 | 抓取不经 Core 的授权绑定与审计，SSRF 检查落在第三方扩展也能绕开的进程里，与 ADR-0004 第 3 条的方向相反 | 否决 |
| TLS 用 aws-lc-rs 或 webpki-roots | rustls 默认实现；根证书随包 | aws-lc-sys 构建更重；内置根证书不认企业根证书 | 否决 |
| 解析与连接分开（先检查域名再交给 HTTP 客户端连接） | 代码少 | 两次解析之间可被 DNS 重绑定 | 否决 |
| 低可靠性按模型名单维护 | 可精确到模型 | 没有可靠来源，名单会过时 | 否决；名单与评测结果留给 T31 的能力降级 |
| Profile 变化时在运行中替换工具描述 | 不重开会话 | Pi 1.5.2 在注册工具时复制描述，替换要改其内部对象 | 否决 |

## 后果

- 正面：WebFetch 的网络访问与文件、命令一样由 Core 授权、审计；SSRF 与规则主机一致性有表驱动单测与集成测试；登录、每模型设置与辅助模型都只经 Core 写入，凭据只在保险箱。
- 负面与代价：新增 rustls、ring、htmd（html5ever）等依赖，Windows 交叉检查需要 C 占位；WebFetch 不支持 gzip 等内容编码，也不走用户的 HTTP 代理（登记为 I112）；Profile 变化会重开会话（MCP 重连）。
- 需要配套做的事：T31 的能力降级与模型别名接入可靠性等级与辅助模型；T41 汇总 `piarc.auxiliaryUsage`。

## 重新评估的触发条件

- 用户普遍处于需要 HTTP 代理才能访问外网的环境（WebFetch 失败率高）；
- 服务商对低可靠性模型给出公开的工具调用评测，或 T31 建立模型评测；
- Pi 提供在运行中更新工具定义的公开接口。
