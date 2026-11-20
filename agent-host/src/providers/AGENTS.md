# agent-host · providers

模型目录、服务商与凭据、每模型偏好、登录，以及 WebFetch 用到的辅助模型通道。命令、进程边界与全局不变量见上级 [`agent-host/AGENTS.md`](../../AGENTS.md)。

## WebFetch、辅助模型、偏好、Profile 与登录（T29，ADR-0045）

- WebFetch（`harness/web-fetch.ts`，Core 启用 `webFetch` 时由 `SessionHarness.tools()` 注册）：`CoreIo.webFetch` 请 Core 抓取（不在本进程联网，SSRF 与授权绑定在 Core），再经 `harness/auxiliary.ts` 的 `AuxiliaryModel.complete` 按 `prompt` 提取；跨站重定向直接把目标地址作为结果，不调模型。提取提示在 `harness/prompts/web-fetch.ts`（改后跑原创性检查）。辅助调用的用量经 `Projector.auxiliaryUsage` 计入当前回合并写 `piarc.auxiliaryUsage`；其他一次性模型调用也走它，不另建请求。
- 模型偏好（`providers/preferences.ts` 的 `ModelPreferencesStore`，挂在 `Workspace.preferences`）：来自 `core/welcome.modelPreferences` 与 `models/reload.preferences`（`SessionRegistry.setPreferences`）。`models/list` 经 `preferences.apply`；窗口经 `SessionCompaction` 的 `contextWindow`（`contextWindowOverride`）；图片经 `checkImageInput` 与 `installProviderPolicy` 的 `vision`；默认 effort 在 `selectModel` 未指定档位时。
- Tool Profile：`#open` 按会话的模型（指定的，或 `buildSessionContext().model`）选 `DEFAULT`/`conservativeProfile`，保守时 `onlyConservative` 只留 `CONSERVATIVE_TOOLS`，`todoWatch` 用 3 轮且无清单也提醒；实际模型与预测不同就立即重开。`setModel` 或 `setPreferences` 改变 Profile 时空闲会话 `#reopen`，运行中的标 `profileStale`、回合结束后重开。不要在运行中改工具描述（Pi 注册时复制描述）。
- 登录（`providers/login.ts` 的 `Logins`，设置 Host 上）：`models/login/start` 调 `ModelRuntime.login(provider, 'oauth', interaction)`，`notify`/`prompt` 转 `ui/loginInteraction`（无期限，取消经 `AbortSignal`），提问的空答复即取消；`models/logout`。`loginProviders` 列出带 `auth.oauth` 的服务商（Anthropic 的已被 policy 移除）。OAuth 流程模块经 `registerLazyOAuthFlows` 打进 bundle。`--test-oauth-provider` 的 `flow` 可选 `authorizationCode`（本地回环回调）与 `deviceCode`（轮询），对接 `piarc-testkit` 的 mock 授权服务器。

## 模型与服务商（T21）

- `models/list` 以 Pi 1.5.2 的 `ModelRuntime.getAvailable()` 为准，只列出已配置的聊天模型。另返回支持 API key 方式的内置服务商，供设置页使用。从 `pi/models.json` 接入兼容服务时，`api` 明确区分 `anthropic-messages`、`openai-completions` 和 `openai-responses`，`models[].id` 是用户给出的部署 ID。目录联网指 Pi 自己的目录刷新；自定义端点的模型列表只从配置读取。
- `providers/catalog.ts` 先从 Pi 读取上下文、最大输出、视觉、推理档位和缓存元数据。适配器明确标记支持严格工具参数编码时，工具可靠性记作 `verified`（指工具参数可按 schema 约束），其他模型记作 `unknown`。最后按完整的服务商 ID / 模型 ID 合并 PiArc 覆盖表。百炼团队版 `qwen-token-plan-cn/qwen3.6-plus` 的 Pi 目录缺少缓存信息，而百炼用量记录明确包含其缓存 Token，因此覆盖为支持缓存。百炼四个内置 Token Plan 的额度以 Credits 计，切换预览里的 USD 金额显示未知。[阿里云 Token Plan 用量与额度](https://help.aliyun.com/zh/model-studio/token-plan-usage-quota)
- 可选 effort 取 Pi 的 `getSupportedThinkingLevels`，过滤 `minimal`，保留 `off/low/medium/high/xhigh/max` 原值。Host 在调用 `setThinkingLevel` 前核实该档位。切换仅可在空闲时确认；`setModel` 和 `setThinkingLevel` 把会话选择写入 Pi 会话树。预览使用 Pi 的上下文估算及目标档位价格，检查已有 thinking 块的 provider、api、id。自定义模型未提供的缓存写价在 Pi 会变成默认零，Host 单独记录这些模型以显示未知。
- 设置专用 Host 的 `models/credential` 通过 `ModelRuntime.login/logout` 和 Core 保险箱适配层写入。认证信息的 `env` 是单次 SDK 请求的参数。自定义密钥绑定 base URL 和 API；在 SDK 每次解析认证后核对实际目标，不匹配则拒绝发送。空 key 的兼容端点可使用 Core 生成的非秘密固定值。Bedrock 支持 bearer/region 和 profile，Vertex 支持 API key 或带项目、位置的本机 ADC / 服务账号文件。
- `providers/policy.ts` 在首次刷新之前移除 Anthropic 的 OAuth 方式。直接调用返回 `permissionDenied`，`sk-ant-oat` 格式及 Anthropic 的环境 token 也在请求认证时拒绝。流错误内回显的请求密钥在 Pi 持久化前脱敏。该路径的 CI 在 `providers/policy.test.ts`，包含 “removes Anthropic OAuth and rejects direct login” 及实际 SDK 流测试。
- `core/welcome.allowModelNetwork` 给出启动的刷新策略。关闭时只读 Pi 自带目录和同一 agentDir 的 `models-store.json`；`models/reload` 先对齐保险箱快照，再重载模型配置，显式启用网络时由 Pi 的缓存时效策略决定是否请求。设置 Host 与测试夹具可全程离线。

## 凭据适配层

- 启动：`load()` 调 `secrets/getAll`；失败只记日志，之后每个需要凭据的操作重试一次，仍失败就以 Core 的结构化错误拒绝，pi-ai 让该次模型请求失败（会话报错）。不要在失败时回退到 `InMemoryCredentialStore` 或环境变量。
- 读：`read`、`list` 从内存返回，不访问 Core。
- 写：`modify`、`delete` 按 provider 串行，在 Core 的连接级锁（`secrets/lock`，锁 `provider/<id>` 与 `oauth/<id>`）内运行，持锁期间用 `secrets/renew` 续约：用锁结果更新内存 → `fn` → 先改内存 → `secrets/set`/`secrets/delete` → `secrets/unlock`。`modify` 等 Core 存好才完成；写回失败时拒绝，但新值留在内存（轮换后的 refresh token 只在那里）。
- 缓存更新：Core 把每次写入推给所有调用过 `secrets/getAll` 的 Agent Host（`secrets/changed`）；`applyChange` 只接受比已知更大的 `revision`。Core 先订阅、再在同一把保险箱锁下读取条目和快照 revision；新快照会剔除已经删除的凭据、丢弃快照之前的迟到通知，并保留期间收到的更高 revision。别的 Agent Host 刷新过的 token 在下一次加锁时一定能看到（锁结果带当前值），不依赖推送先到。
- 键：API key 在 `provider/<id>`，OAuth 在 `oauth/<id>`，写一个就删另一个；`mcp/*` 不进 Pi 的凭据视图。
- 退出前 `flush()` 等待进行中的写入（`host.ts` 的 `shutdown` 与 `host/shutdown`）。
