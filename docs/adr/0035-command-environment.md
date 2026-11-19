# 0035. 工具命令可继承的环境

- 状态：已接受
- 日期：2026-11-19
- 修订：[ADR-0028](0028-shell-command-execution.md) 第 1 条中的环境继承约定
- 相关：T17-A08、架构第 6.11 节、R2 工具不变量审查

## 背景

原实现从用户登录 shell 或进程环境中过滤 PiArc、Pi、Electron 和 Node 的内部变量。用户已经导出的服务商密钥、云凭据和带认证信息的仓库地址仍可进入模型调用的命令。变量名和凭据格式可由用户或其他程序定义。

## 决策

1. 对模型发起的 Bash 和 PowerShell，Core 仅复制 `piarc_exec::env::command_environment` 列出的字段，包含系统与用户目录、PATH、临时目录、locale 和工具链根目录等。Windows 变量名按大小写不敏感匹配。Core 在首次解析时缓存筛选后的列表。
2. macOS 继续通过用户登录 shell 取得工具链的 PATH 和 locale。解析失败时使用同一准入规则筛选 Core 的环境。Windows 使用这一规则筛选进程环境。PowerShell 使用 `-NoProfile`；Bash 的工作目录回报通过 Core 自己创建的 `BASH_ENV` 完成。
3. 自动审批继续检查原始 shell 环境中是否存在自定义启动或命令解析行为。Core 缓存这个判断所需的布尔值。Windows Git Bash 的程序定位探测也只继承准入列表。生产路径拒绝模型为命令附加环境覆盖；沙箱代理等宿主生成的变量由 Core 注入。
4. 用户自定义构建变量、第三方凭据字段和可能内嵌认证信息的代理 / 仓库 URL 默认无法继承。PiArc 保险箱沿用 AHP 凭据通道。显式读取用户目录中的凭据文件、把秘密放进被允许的字段或在命令文本中直接指定值，属于不同的数据通道。

## 验证

`exec-env-internal-vars` 和 `exec-env-login-path` 使用独立测试环境、合成变量及临时登录配置，检查系统变量、工具链 PATH 和 locale。Core 的 `inherited_private_variables_are_filtered_on_process_environment_fallback` 通过实际命令覆盖 Unix 回退与 Windows 进程环境分支。Windows 原生执行留 W1。

## 重新评估的触发条件

凭据化工具链、Windows 安装差异或沙箱接入要求新增环境字段时，逐项评估用途和暴露范围。
