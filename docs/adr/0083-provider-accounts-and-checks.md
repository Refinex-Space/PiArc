# 0083. 服务商的账号、连接测试、启停与模型发现

- 状态：已接受（用户在会话中要求补齐这五项）
- 日期：2026-11-25
- 来源：用户要求参照 PI-Desktop 的“模型 / 添加服务”，补上“已登录为某某账号”、测试连接、服务商启停、从端点 `/models` 获取模型、同一服务商登录多个账号
- 相关：ADR-0021（凭据只在保险箱）、0032（服务商设置经设置 Host）、0045（登录）、0082（代理）；架构第 5.4、10 节

## 背景

服务商设置（T21）与登录（T29）只做了“配一个、登一个”：列表看不出登录的是哪个账号，不能确认配置是否可用，不能临时停用，自定义端点要手抄模型 ID，同一服务商只能有一个登录。Pi 的 `ModelRuntime` 每个服务商只存一份凭据（键是服务商 ID），pi-ai 的请求适配器还按 `model.provider` 区分 Copilot、xAI、OpenRouter 等的请求头与格式，所以不能把第二个账号注册成另一个 ID 的克隆服务商。

## 决策

1. **当前账号与其他账号。** 一个服务商可以有多个已登录账号，同一时刻只有一个在用：在用账号的凭据仍在 `oauth/<服务商>`（与现在相同，Pi 照常使用）；其余账号的凭据在保险箱新前缀 `account/<服务商>/<账号 id>` 下。`account/` 与 `websearch/` 一样只给 Core 读写，Agent Host 读、写、锁、列举都不行。账号的公开信息（id、服务商、显示名、是否在用）记在用户 `settings.json` 的 `modelProviders.accounts`。
2. **新增账号。** 已有在用账号时再登录：Core 先把在用凭据复制到 `account/…` 并把它记为其他账号，再运行登录；登录失败或取消时把它放回 `oauth/<服务商>`。登录成功后新账号在用；与新账号显示名相同的旧记录视为同一账号，删除。
3. **切换与移除。** 切换时 Core 先把在用凭据移到 `account/…`，再把选中账号的凭据写到 `oauth/<服务商>` 并删除它的 `account/` 条目；运行中的 Agent Host 经 `secrets/changed` 拿到新凭据，下一次请求就用新账号。移除其他账号只删 `account/` 条目与记录；退出在用账号沿用 `models/logout`。
4. **账号显示名。** Agent Host 从凭据推导：先读凭据里的 `email`、`login`、`username` 等字段，再解码 access token 与 id token 的 JWT（`email`、`preferred_username`、OpenAI 的 `https://api.openai.com/profile.email`）。GitHub Copilot 的令牌不含身份，登录完成时用同一令牌请求一次 `https://api.github.com/user` 取登录名。推导结果经 `models/list` 的 `loginProviders[].account` 与 `models/login/start` 的结果交给 Core；推导不出时界面只显示服务商名。只取显示名，令牌不离开 Agent Host。
5. **测试连接。** 新 AHP 方法 `models/test`（Core → 设置 Host）：在该服务商可用的模型里取第一个（或指定的模型）发一次很短的请求（输出上限 16 token，30 s 超时），回答是否成功、用的模型、耗时，失败时附错误与是否为连接类失败（ADR-0082 的 `network`）。只在用户点击时发起，会消耗极少量 token。
6. **启用与停用。** 用户 `settings.json` 的 `modelProviders.disabled` 列出停用的服务商 ID（已配置的服务商与登录服务商都可停用）。它随模型偏好（`ModelPreferences.disabledProviders`）交给工作区的 Agent Host：凭据适配层对停用服务商的凭据视而不见，所以 Pi 把它当作未配置，模型菜单、会话选择、别名解析都看不到它；自定义与本地端点另外从 `pi/models.json` 移除，启用时写回。设置 Host 不受影响，设置页始终看到真实状态，也能测试停用的服务商。
7. **获取模型列表。** 新 AHP 方法 `models/discover`（Core → 设置 Host）：按协议请求端点的模型列表（OpenAI 兼容为 `<baseUrl>/models`，Anthropic 兼容先试 `<baseUrl>/v1/models` 再试 `<baseUrl>/models`），返回去重排序后的模型 ID（至多 512 个）。密钥取表单里刚填的；没填且地址与协议都和已保存的配置相同时，用保险箱里已存的密钥（由 Core 判断，地址或协议变了就不带密钥，不把密钥发给另一个主机）。带密钥的明文 HTTP 只允许回环地址，与保存时的规则相同。

## 不采用

- 每个账号一个克隆服务商 ID：pi-ai 按 `model.provider` 处理请求格式，克隆后 Copilot 等请求会出错。
- 每个账号一个独立的 `ModelRuntime`：要改 Agent Host 的工作区模型与会话选择，代价远大于一次切换。
- 让 Agent Host 读其他账号的凭据：其他账号只在 Core 切换时用到，没有理由交出。
- 测试连接只请求 `/models`：内置服务商与登录服务商未必有可用的列表接口，也测不出凭据能否真正调用模型。
