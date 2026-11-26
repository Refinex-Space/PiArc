# 威胁覆盖

> 由 `node scripts/ci/check-threats.mjs --results target/l2/results.json --doc write` 根据 `tests/security/threats.yaml`、架构第 10.1 节与 L2 场景结果生成，不要手工编辑。新增安全对策的登记方法见 `docs/engineering/testing.md` 第 16 节。

测试 ID 的种类：**L2** = 能力 ID 与覆盖它的场景（verify 第 14 步）；**Rust** = `cargo test`（verify 第 8 步）；**Vitest** = verify 第 5 步；**L4** = Playwright（CI `desktop` 作业）；**CI** = 打包产物上的检查脚本（CI `desktop` 作业）；**流程** = PR 模板等人工检查项。对策类型：**自动化**、**流程**、**已接受风险**（写明理由与 ADR 或登记事项）、**待补**（由所列任务补测试）。

## 汇总

| 编号 | 威胁 | 对策 | 自动化 | 流程 | 已接受风险 | 待补 | 测试 ID |
|---|---|---|---|---|---|---|---|
| THR-01 | 提示注入导致破坏性操作 | 7 | 7 | 0 | 0 | 0 | 23 |
| THR-02 | 恶意项目配置 | 5 | 5 | 0 | 0 | 0 | 25 |
| THR-03 | 恶意插件 / MCP server / Pi 包 | 5 | 4 | 0 | 1 | 0 | 14 |
| THR-04 | 凭据泄露 | 5 | 5 | 0 | 0 | 0 | 25 |
| THR-05 | 沙箱逃逸 | 5 | 4 | 0 | 1 | 0 | 10 |
| THR-06 | 审批疲劳与误点 | 5 | 5 | 0 | 0 | 0 | 13 |
| THR-07 | 多窗口审批错乱 | 1 | 1 | 0 | 0 | 0 | 5 |
| THR-08 | 供应链 | 4 | 3 | 1 | 0 | 0 | 10 |
| THR-09 | 更新通道被劫持 | 4 | 1 | 0 | 1 | 2 | 5 |
| THR-10 | 应用文件被篡改 | 3 | 1 | 1 | 1 | 0 | 3 |
| THR-11 | 渲染进程注入（XSS） | 7 | 7 | 0 | 0 | 0 | 28 |
| THR-12 | 应用被当作通用运行时滥用 | 3 | 3 | 0 | 0 | 0 | 10 |
| THR-13 | 恶意链接与导航 | 4 | 4 | 0 | 0 | 0 | 15 |
| THR-14 | 同一用户的进程向 PiArc 注入代码 | 3 | 2 | 0 | 1 | 0 | 4 |
| THR-15 | 恶意仓库的 Git 配置 | 4 | 4 | 0 | 0 | 0 | 11 |
| THR-16 | 浏览器外传与本机服务访问 | 5 | 5 | 0 | 0 | 0 | 24 |
| THR-17 | 浏览器凭据 | 4 | 3 | 0 | 1 | 0 | 12 |

## THR-01 提示注入导致破坏性操作

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 手动模式下非只读的命令与改动先询问 | 自动化 | Rust `crates/piarc-policy/src/decision/tests.rs` · mode_defaults<br>L2 CAP-PERM-MODE-001：`policy-accept-edits`、`policy-accept-edits-powershell`、`policy-manual`、`policy-manual-powershell`、`policy-mode-restore`、`policy-shell-boundary`、`policy-untrusted`<br>L2 CAP-PERM-READONLY-001：`perm-read-only` |
| deny 规则优先于 allow 与 hook 的允许 | 自动化 | Rust `crates/piarc-policy/src/decision/tests.rs` · deny_then_ask_then_allow_and_allow_never_beats_deny<br>Rust `crates/piarc-core/src/tool_io/hooks_tests.rs` · a_hook_allow_leaves_deny_rules_ask_rules_and_plan_mode_in_force<br>L2 CAP-PERM-RULE-001：`perm-powershell-whole`（仅 windows）、`perm-rule-match`、`sec-read-deny-search`、`subagent-denied-type`、`webfetch-domain-rules`、`worktree-session-rules` |
| 复合命令逐个子命令裁决，分析不了的命令询问 | 自动化 | Rust `crates/piarc-policy/tests/bash_cases.rs` · data_driven_cases<br>Rust `crates/piarc-policy/tests/bash_cases.rs` · random_input_does_not_panic<br>L2 CAP-PERM-BASH-001：`perm-bash-compound` |
| 删除主目录、工作区根等关键路径在任何模式下询问，包括跳过权限与沙箱自动批准 | 自动化 | Rust `crates/piarc-policy/src/decision/tests.rs` · mandatory_asks_hold_in_every_mode<br>Rust `crates/piarc-core/src/tool_io/policy/tests/t23.rs` · critical_deletions_ask_even_in_bypass_with_an_allow_rule<br>L2 CAP-PERM-CRITICAL-001：`perm-critical-delete`<br>L2 CAP-SANDBOX-AUTO-001：`sandbox-auto-allow`（仅 macos）、`sandbox-auto-ask-rule`（仅 macos）、`sandbox-auto-critical-delete`（仅 macos）、`sandbox-auto-deny-rule`（仅 macos）、`sandbox-auto-plan`（仅 macos）<br>L2 CAP-SEC-INJECTION-001：`sec-inject-mcp`、`sec-inject-repo-file`、`sec-inject-webfetch` |
| 命令沙箱限制写入范围与网络（macOS） | 自动化 | Rust `crates/piarc-core/tests/sandbox.rs` · writes_stay_inside_the_writable_directories<br>Rust `crates/piarc-core/tests/sandbox.rs` · protected_paths_refuse_writes<br>L2 CAP-SANDBOX-MACOS-001：`sandbox-ask-writes`（仅 macos） |
| 审批卡显示完整命令 | 自动化 | Vitest `apps/desktop/src/renderer/transcript/rows/rows.test.tsx` · renders the five ledger card kinds, keeps approvals through a history reload, and removes invalidated requests<br>L4 `apps/desktop/e2e/t19-security.e2e.ts` · renders reply, tool output, command output and file paths as inert text<br>L2 CAP-SEC-INJECTION-001：`sec-inject-mcp`、`sec-inject-repo-file`、`sec-inject-webfetch`<br>Vitest `apps/desktop/src/renderer/transcript/reveal.test.ts` · THR-01 shows every bidirectional control as a visible marker, in place |
| 网页只作为辅助模型的材料，提取结果是工具结果 | 自动化 | Vitest `agent-host/src/harness/web-fetch.test.ts` · fetches through Core and answers with the auxiliary model<br>Rust `crates/piarc-core/src/tool_io/policy/tests/t29.rs` · a_fetch_needs_the_approved_url<br>L2 CAP-TOOL-WEBFETCH-001：`webfetch-auxiliary-model`、`webfetch-domain-rules`、`webfetch-extract`、`webfetch-redirects-limits`<br>L2 CAP-SEC-INJECTION-001：`sec-inject-mcp`、`sec-inject-repo-file`、`sec-inject-webfetch` |

## THR-02 恶意项目配置

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 内置浏览器里来自网页的文字（Browser 工具的输出、加入对话的元素上下文、浏览器状态提醒）放在随机 nonce 的边界里并写明是网页数据，网页文字关不掉边界；用户的评论写在边界外 | 自动化 | Vitest `agent-host/src/harness/browser.test.ts` · wraps the output in a boundary page text cannot close<br>Vitest `agent-host/src/harness/browser.test.ts` · lists the spaces inside a nonce boundary the titles cannot close<br>Vitest `apps/desktop/src/renderer/composer/browser-context.test.ts` · opens with the data notice inside a nonce boundary and numbers the items<br>Vitest `apps/desktop/src/renderer/composer/browser-context.test.ts` · escapes page text so it cannot close the boundary<br>Vitest `apps/desktop/src/renderer/composer/browser-context.test.ts` · puts the user’s comments above the boundary, by number |
| 信任前不运行项目 hooks、不连项目 MCP、不应用项目 allow 规则、不加载项目插件与 Pi 扩展 | 自动化 | Rust `crates/piarc-config/tests/settings.rs` · project_executables_wait_for_trust_and_deny_rules_do_not<br>Rust `crates/piarc-core/src/tool_io/hooks_tests.rs` · untrusted_project_hooks_wait_for_trust_while_user_hooks_run<br>Rust `crates/piarc-core/src/mcp/tests.rs` · an_untrusted_projects_servers_wait_and_user_servers_are_ready<br>Rust `crates/piarc-core/src/plugins/tests.rs` · an_untrusted_project_loads_no_project_package_and_trust_confirms_its_items<br>Rust `crates/piarc-testkit/tests/agent_host/trust.rs` · project_extensions_load_only_while_core_trusts_the_project<br>Vitest `agent-host/src/harness/project-trust.test.ts` · is untrusted when Core does not answer in time<br>L2 CAP-TRUST-PROJECT-001：`trust-trusted-loads-project-extension`、`trust-untrusted-skips-project-extension`<br>L2 CAP-MCP-TRUST-001：`mcp-subagent-untrusted`、`mcp-untrusted-project`<br>L2 CAP-PLUGIN-TRUST-001：`plugin-untrusted-project`<br>L2 CAP-CONFIG-COMPAT-001：`config-merge-order`、`config-untrusted-project`、`model-default-setting`<br>L2 CAP-SEC-MALICIOUS-REPO-001：`sec-malicious-repo-new-item`、`sec-malicious-repo-untrusted` |
| 项目配置新增的可执行项在再次确认前不生效 | 自动化 | Rust `crates/piarc-core/tests/state.rs` · a_trust_view_lists_the_items_and_what_is_new_since_the_decision<br>Rust `crates/piarc-config/tests/executables.rs` · lists_every_category_with_its_source_and_detects_new_items<br>L4 `apps/desktop/e2e/t18-trust.e2e.ts` · the trust dialog lists the items; the decision decides what the model gets<br>L2 CAP-SEC-MALICIOUS-REPO-001：`sec-malicious-repo-new-item`、`sec-malicious-repo-untrusted` |
| 项目文件选不了跳过权限与 auto，项目的沙箱设置只能收紧 | 自动化 | Rust `crates/piarc-config/tests/claude.rs` · project_files_cannot_select_bypass_or_auto_and_the_diagnostics_say_why<br>Rust `crates/piarc-core/src/tool_io/policy/tests/t23.rs` · bypass_needs_the_user_setting_and_project_modes_are_ignored<br>Rust `crates/piarc-config/src/sandbox.rs` · a_project_cannot_turn_the_sandbox_off<br>L2 CAP-SANDBOX-PROJECT-001：`sandbox-project-tightens`（仅 macos） |
| 信任查询任何失败都按不信任 | 自动化 | Rust `crates/piarc-core/tests/state.rs` · trust_get_answers_untrusted_on_every_failure<br>Vitest `agent-host/src/harness/project-trust.test.ts` · is untrusted when the connection to Core is gone |

## THR-03 恶意插件 / MCP server / Pi 包

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 启用前的原生确认列出来源与每个可执行项 | 自动化 | Vitest `apps/desktop/src/main/core/plugins-ipc.test.ts` · lists the source and every executable item, with the extension note<br>L4 `apps/desktop/e2e/t40-plugins.e2e.ts` · packages install off, turn on only after the native confirmation, and list what is unsupported<br>L2 CAP-PLUGIN-001：`plugin-commands` |
| 启用与更新带来的新增项需确认；npm 只经内置 npm，不运行安装脚本，不读包自带的 .npmrc | 自动化 | Rust `crates/piarc-core/src/plugins/tests.rs` · npm_installs_run_the_bundled_npm_without_scripts<br>Rust `crates/piarc-core/src/plugins/tests.rs` · thr03_a_cloned_packages_npmrc_cannot_choose_what_npm_runs<br>Rust `crates/piarc-core/src/plugins/tests.rs` · a_git_update_leaves_new_items_off_until_confirmed<br>Vitest `apps/desktop/src/main/core/plugins-ipc.test.ts` · answers planned confirmations and records them<br>L2 CAP-PLUGIN-HOOKS-001：`plugin-hooks` |
| Agent Host 及其子进程（MCP server、扩展、npm）只能写工作区与自己的目录（macOS） | 自动化 | Rust `crates/piarc-core/tests/agent_host_profile.rs` · the_agent_host_writes_only_its_places<br>Rust `crates/piarc-core/tests/agent_host_profile.rs` · thr03_the_agent_host_cannot_plant_code_in_pis_directory<br>Rust `crates/piarc-testkit/tests/sessions/sandbox.rs` · the_agent_host_profile_keeps_extensions_and_mcp_servers_in_their_places |
| Windows 上 Agent Host 没有进程级隔离 | 已接受风险 | L2 CAP-SANDBOX-WINDOWS-001：`sandbox-windows-not-applied`（仅 windows）<br>理由：Windows 到 Beta 没有等价的 OS 沙箱，Agent Host 只用 Job Object 管理进程树，没有第二道防线；设置页、环境栏与配置诊断标明沙箱不生效<br>依据：ADR-0057、I180 |
| Pi 自己设置里的包清单不由 Agent Host 安装或加载 | 自动化 | Vitest `agent-host/src/runtime/pi-settings.test.ts` · THR-03 hides every package source from Pi, so nothing installs, runs or loads<br>L2 CAP-SEC-PI-PACKAGES-001：`sec-pi-settings-packages` |

## THR-04 凭据泄露

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 凭据只在 AES-256-GCM 保险箱，主密钥在系统凭据库，磁盘上没有明文 | 自动化 | Rust `crates/piarc-secrets/tests/vault.rs` · round_trips_entries_through_the_encrypted_file<br>Rust `crates/piarc-secrets/tests/vault.rs` · any_modified_byte_fails_with_an_integrity_error<br>Rust `crates/piarc-testkit/tests/sessions/provider_settings.rs` · provider_settings_crud_keeps_credentials_in_the_vault<br>Rust `crates/piarc-testkit/tests/sessions/login.rs` · authorization_code_sign_in_reaches_the_vault_and_signs_out<br>Rust `crates/piarc-core/src/tool_io/policy/tests/t38.rs` · agent_hosts_cannot_reach_search_keys<br>L2 CAP-PROVIDER-OAUTH-001：`login-authorization-code`、`login-device-code` |
| Agent Host、命令与 MCP 子进程的环境没有凭据，只透传白名单变量 | 自动化 | Rust `crates/piarc-host/src/config.rs` · passes_only_named_variables_and_the_fixed_ones<br>Rust `crates/piarc-core/tests/exec_commands.rs` · the_environment_has_no_internal_variables<br>Rust `crates/piarc-testkit/tests/agent_host/credentials.rs` · login_and_one_refresh_reach_the_vault_and_every_session<br>Vitest `agent-host/src/runtime/credentials.test.ts` · reports an unavailable vault and never falls back to the environment<br>Rust `crates/piarc-testkit/tests/credential_leaks.rs` · thr04_a_vault_credential_stays_out_of_child_environments_and_log_files<br>L2 CAP-EXEC-ENV-001：`exec-env-internal-vars` |
| 日志写入前替换保险箱里的凭据值、常见密钥格式、Bearer token 与 JWT（Core 与 Agent Host 的 stderr 同一处理）；服务商回显的密钥在进入会话文件前替换 | 自动化 | Rust `crates/piarc-telemetry/src/redact_tests.rs` · thr04_remembered_credentials_are_replaced_wherever_they_appear<br>Rust `crates/piarc-telemetry/src/redact_tests.rs` · thr04_provider_key_formats_are_replaced<br>Rust `crates/piarc-telemetry/src/redact_tests.rs` · thr04_cloud_access_keys_are_replaced<br>Rust `crates/piarc-telemetry/src/redact_tests.rs` · thr04_bearer_tokens_and_jwts_are_replaced_keeping_the_scheme<br>Rust `crates/piarc-telemetry/src/redact_tests.rs` · thr04_environment_style_secret_names_are_replaced<br>Rust `crates/piarc-telemetry/tests/redaction.rs` · thr04_credentials_in_core_and_agent_host_lines_reach_the_files_redacted<br>Rust `crates/piarc-testkit/tests/credential_leaks.rs` · thr04_a_vault_credential_stays_out_of_child_environments_and_log_files<br>Vitest `agent-host/src/providers/policy.test.ts` · redacts the provider key echoed by an HTTP error before the Pi session can persist it |
| 数据只在本机：一次完整 mock 会话里，Agent Host 只连模型服务商，Electron（主进程、渲染进程、Chromium 后台）没有外连；PiArc 没有遥测（外连清单见 docs/security/egress.md） | 自动化 | Rust `crates/piarc-testkit/tests/egress.rs` · thr04_a_whole_mock_session_connects_only_to_the_model_provider<br>L4 `apps/desktop/e2e/t45-egress.e2e.ts` · THR-04 a whole mock session makes no outbound connection from Electron<br>Rust `crates/piarc-host/src/config.rs` · passes_only_named_variables_and_the_fixed_ones |
| 诊断包由用户手动导出：先展示文件清单与脱敏摘要，经主进程保存对话框确认后才写出；不含保险箱、数据库与会话内容，主目录写作 ~ | 自动化 | Rust `crates/piarc-telemetry/src/bundle_tests.rs` · thr04_the_bundle_carries_no_credential_and_no_home_path<br>Rust `crates/piarc-core/tests/diagnostics.rs` · thr04_the_exported_bundle_holds_no_credential_session_content_or_home_path<br>Vitest `apps/desktop/src/main/core/diagnostics-ipc.test.ts` · prepares with the client versions and writes nothing until the user picks a place<br>L4 `apps/desktop/e2e/t45-diagnostics.e2e.ts` · the diagnostic bundle shows what it holds and is written only where the user chooses |

## THR-05 沙箱逃逸

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 沙箱内只能经会话代理联网，白名单外的主机询问 | 自动化 | Rust `crates/piarc-core/tests/sandbox.rs` · connections_around_the_proxy_fail<br>Rust `crates/piarc-sandbox/tests/proxy.rs` · connect_outside_the_allowlist_is_refused_with_a_reason<br>Rust `crates/piarc-sandbox/tests/proxy.rs` · names_resolving_to_loopback_or_metadata_are_refused<br>Rust `crates/piarc-testkit/tests/sessions/sandbox.rs` · hosts_outside_the_allowlist_ask_and_a_changed_allowlist_applies_to_the_next_command |
| 沙箱外重试在任何模式下询问，只能允许一次 | 自动化 | Rust `crates/piarc-policy/src/decision/tests.rs` · an_unsandboxed_command_asks_in_every_mode<br>L2 CAP-SANDBOX-RETRY-001：`sandbox-unsandboxed-retry`（仅 macos） |
| agent 启动进程的每条路径都经同一沙箱包装 | 自动化 | L2 CAP-SANDBOX-PATHS-001：`sandbox-launch-paths`（仅 macos）、`sandbox-terminal`（仅 macos） |
| 内置浏览器的脚本宿主（智能体的 Browser 脚本）是不能联网的沙箱页面，宿主分区的请求全部取消（ADR-0091） | 自动化 | L4 `apps/desktop/e2e/browser-agent.e2e.ts` · THR-05: the script host reaches nothing on the network<br>Vitest `apps/desktop/src/main/browser/host-session.test.ts` · allows scripts only from the host and no connections |
| Windows 上没有命令沙箱 | 已接受风险 | L2 CAP-SANDBOX-WINDOWS-001：`sandbox-windows-not-applied`（仅 windows）<br>理由：Windows 到 Beta 没有 OS 级沙箱（需求 D7），经批准的命令可以写工作区外与外传数据；沙箱开关在 Windows 上不可用且说明原因<br>依据：ADR-0057、I180 |

## THR-06 审批疲劳与误点

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 新卡片 400 ms 内的按键不作答 | 自动化 | Vitest `apps/desktop/src/renderer/transcript/rows/approval-keys.test.ts` · arms the first visible card at 400 ms and ignores repeats<br>L4 `apps/desktop/e2e/t43-approval-focus.e2e.ts` · a new card takes focus on its container, waits for a composition, and guards Enter for 400 ms |
| 折叠的长参数展开之前不能"总是允许" | 自动化 | Vitest `apps/desktop/src/renderer/transcript/rows/approval-keys.test.ts` · gates persistent rules on protected paths and collapsed parameters<br>L4 `apps/desktop/e2e/t20-approvals.e2e.ts` · guards approval shortcuts with the actual composer, focused card and visible order |
| "总是允许"逐条可编辑，经原生确认保存，设置页可删除 | 自动化 | L4 `apps/desktop/e2e/t23-permissions.e2e.ts` · always allow saves one edited rule per subcommand; bypass needs settings and a native confirmation<br>L4 `apps/desktop/e2e/t23-permissions.e2e.ts` · the Permissions page edits rules by source behind a native confirmation and filters the audit<br>Rust `crates/piarc-core/src/tool_io/policy/tests.rs` · permanent_answers_must_include_every_value_shown_for_confirmation<br>L2 CAP-PERM-APPROVAL-001：`policy-extra-directory`、`policy-save-rule`、`policy-session-rule`、`subagent-approval` |
| 审批结果与规则命中写入审计，设置页可筛选 | 自动化 | Rust `crates/piarc-core/src/tool_io/policy/tests.rs` · concurrent_answers_apply_once_and_each_decision_is_audited_by_session<br>Rust `crates/piarc-core/src/tool_io/policy/tests/t23.rs` · settings_page_lists_edits_and_audits_rules<br>L2 CAP-PERM-AUDIT-001：`perm-bash-compound` |
| 系统通知对高风险请求只给"打开" | 自动化 | Rust `crates/piarc-core/src/tool_io/policy/tests/t42.rs` · long_critical_and_protected_requests_only_open_the_card<br>Vitest `apps/desktop/src/main/platform/attention.test.ts` · only opens a request a notification may not allow |

## THR-07 多窗口审批错乱

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 同一请求只采用第一个有效答复，过期的 revision 与连接代次被拒 | 自动化 | Rust `crates/piarc-core/src/tool_io/policy/tests.rs` · concurrent_answers_apply_once_and_each_decision_is_audited_by_session<br>Rust `crates/piarc-core/src/tool_io/policy/tests.rs` · disconnect_expires_pending_cards_and_records_refusal_for_recovery<br>Rust `crates/piarc-testkit/tests/sessions/permissions.rs` · only_one_answer_applies_and_the_mode_entry_survives_core_restart<br>L4 `apps/desktop/e2e/t35-windows.e2e.ts` · one approval in two windows takes the first answer and leaves both<br>L4 `apps/desktop/e2e/t42-notify.e2e.ts` · approval notifications answer through the ledger |

## THR-08 供应链

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| npm 依赖精确版本；Cargo 依赖只在工作区声明且精确版本 | 自动化 | Vitest `scripts/ci/supply-chain.test.mjs` · THR-08 every npm dependency is pinned to an exact version<br>Vitest `scripts/ci/supply-chain.test.mjs` · THR-08 Cargo dependencies are declared once in the workspace with exact versions |
| CI 安装依赖不运行安装脚本 | 自动化 | Vitest `scripts/ci/supply-chain.test.mjs` · THR-08 every CI install of the dependencies runs without install scripts |
| 安全公告、许可证与来源检查；高危与严重问题没有现行例外即失败 | 自动化 | Vitest `scripts/lib/audit.test.mjs` · THR-08 fails on high and critical npm advisories and every cargo vulnerability without a current exception<br>Vitest `scripts/lib/audit.test.mjs` · THR-08 an exception past its review date no longer covers the advisory and fails<br>Vitest `scripts/lib/audit.test.mjs` · THR-08 checks the licenses of the npm packages that ship, not the development tools<br>CI `scripts/ci/audit-deps.mjs`<br>CI `scripts/dev/verify.mjs` · cargo-deny |
| 新增依赖在 PR 中评审 | 流程 | 流程 `.github/pull_request_template.md` · dependency-review<br>Vitest `scripts/ci/supply-chain.test.mjs` · THR-08 the pull request template asks for a review of new dependencies and their sources<br>理由：是否引入一个依赖要人判断（用途、替代方案、维护状况、许可证、体积）；PR 模板的检查项要求写明，测试保证模板里有这一项 |

## THR-09 更新通道被劫持

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 更新只经 HTTPS 下载 | 待补 | 理由：更新流程由 T50 实现，届时补测试并更新本条<br>由 T50 补测试 |
| 发布清单签名与文件哈希校验，篡改即拒绝 | 自动化 | Rust `crates/piarc-core/tests/release.rs` · a_signed_manifest_and_its_files_verify<br>Rust `crates/piarc-core/tests/release.rs` · changed_manifest_content_is_refused<br>Rust `crates/piarc-core/tests/release.rs` · a_file_whose_hash_differs_from_the_manifest_is_refused<br>Rust `crates/piarc-core/tests/release.rs` · a_manifest_signed_with_another_key_is_refused<br>Vitest `scripts/release/release-manifest.test.mjs` · rejects changed content, a changed trusted comment and another key |
| 清单签名私钥只在受保护的发布环境 | 待补 | 理由：发布流水线与受保护环境由 T50 建立<br>由 T50 补测试 |
| 发布账号被攻破 | 已接受风险 | 理由：清单签名只防下载渠道与镜像被篡改；能以发布账号身份签名与发布的攻击者不在防护范围内<br>依据：ADR-0018 |

## THR-10 应用文件被篡改

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| ASAR 完整性校验与 OnlyLoadAppFromAsar（发布构建的 fuse） | 自动化 | Vitest `scripts/ci/check-fuses.test.mjs` · release settings follow ADR-0018 rule 1<br>Vitest `scripts/ci/check-fuses.test.mjs` · names a fuse whose state differs<br>CI `scripts/ci/check-fuses.mjs` |
| 本机攻击者篡改安装目录 | 已接受风险 | 理由：没有平台签名时完整性信息本身不受保护；能写安装目录的本机攻击者已能以用户身份运行任意程序<br>依据：ADR-0018 |
| 安装在系统默认目录 | 流程 | 理由：安装位置由安装器决定（macOS 拖入"应用程序"，Windows 由 Velopack 装在用户目录），首次运行指引说明<br>依据：ADR-0018 |

## THR-11 渲染进程注入（XSS）

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 所有窗口 sandbox、contextIsolation，页面没有 Node 全局 | 自动化 | Vitest `apps/desktop/src/main/web-preferences.test.ts` · fixes the security-relevant preferences<br>L4 `apps/desktop/e2e/preload.e2e.ts` · require, process, module and Buffer are not defined in the page<br>L4 `apps/desktop/e2e/preload.e2e.ts` · the window renderer runs in the OS-level sandbox<br>L4 `apps/desktop/e2e/browser-basic.e2e.ts` · THR-11 guests reach neither the preload nor Node |
| 主进程下发的 CSP 不允许内联脚本、eval 与外部资源 | 自动化 | Vitest `apps/desktop/src/main/security/csp.test.ts` · allows no inline code or eval<br>L4 `apps/desktop/e2e/csp.e2e.ts` · does not run an injected inline script<br>L4 `apps/desktop/e2e/csp.e2e.ts` · refuses eval and the Function constructor<br>L4 `apps/desktop/e2e/csp.e2e.ts` · blocks fetch to an external address |
| 模型输出的原始 HTML 作为文本，链接只保留安全协议 | 自动化 | Vitest `apps/desktop/src/renderer/transcript/markdown/to-ir.test.ts` · turns every XSS payload into text or a link without a dangerous target<br>Vitest `apps/desktop/src/renderer/transcript/markdown/to-ir.test.ts` · drops every other target, including encoded ones<br>Vitest `apps/desktop/src/renderer/transcript/markdown/to-ir.test.ts` · keeps raw HTML as html nodes, verbatim |
| window.piarc 只有白名单函数，主进程按 senderFrame 的 origin 拒绝外来请求 | 自动化 | L4 `apps/desktop/e2e/preload.e2e.ts` · window.piarc exposes exactly the allowlisted functions<br>L4 `apps/desktop/e2e/preload.e2e.ts` · IPC from another origin is rejected<br>L4 `apps/desktop/e2e/preload.e2e.ts` · IPC from an origin that only starts with the app origin is rejected<br>Vitest `apps/desktop/src/main/ipc/sender.test.ts` · rejects origins that only start with the app origin<br>Vitest `apps/desktop/src/main/browser/browser-ipc.test.ts` · THR-11 rejects %j<br>L4 `apps/desktop/e2e/browser-picker.e2e.ts` · THR-11 a picked element with markup in its id and text shows it as text<br>L4 `apps/desktop/e2e/t45-ipc-hardening.e2e.ts` · THR-11 every window.piarc command answers malformed arguments with a structured error and the main process lives |
| 终端写入要求真实输入；"总是允许"与 allow 规则经主进程原生确认 | 自动化 | Vitest `apps/desktop/src/main/core/terminal-ipc.test.ts` · refuses writes without recent real input; pointer moves need none<br>L4 `apps/desktop/e2e/t20-approvals.e2e.ts` · edits and confirms an exact rule, declines protected writes and restores the chosen mode<br>L4 `apps/desktop/e2e/t45-ipc-hardening.e2e.ts` · THR-11 allow rules, always-allow answers and sandbox loosening from the page wait for the native confirmation |
| 发布构建的渲染进程不带测试页（事件探针、transcript 与终端原型） | 自动化 | Vitest `scripts/ci/check-app-layout.test.mjs` · finds the renderer's test-page chunk on both separators and nothing else<br>CI `scripts/ci/check-app-layout.mjs` |
| XSS 载荷集在渲染面上以文本呈现 | 自动化 | L4 `apps/desktop/e2e/transcript-security.e2e.ts` · renders every payload of a finished message as inert text<br>L4 `apps/desktop/e2e/transcript-security.e2e.ts` · renders the payloads inertly while they stream<br>L4 `apps/desktop/e2e/t19-security.e2e.ts` · renders reply, tool output, command output and file paths as inert text<br>L4 `apps/desktop/e2e/t45-xss.e2e.ts` · THR-11 approval cards, the Changes diff and its comments show the payloads as text<br>L4 `apps/desktop/e2e/t45-xss.e2e.ts` · THR-11 settings pages and a hook notice show names, values and messages as text |

## THR-12 应用被当作通用运行时滥用

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 发布构建关闭 RunAsNode、NodeOptions、NodeCliInspect，打包产物上实际不生效 | 自动化 | Vitest `scripts/ci/check-fuses.test.mjs` · release settings follow ADR-0018 rule 1<br>Vitest `scripts/ci/check-fuses.test.mjs` · development settings differ only in EnableNodeCliInspectArguments<br>CI `scripts/ci/check-fuses.mjs`<br>CI `scripts/ci/check-release-runtime.mjs` · run-as-node<br>CI `scripts/ci/check-release-runtime.mjs` · node-options<br>CI `scripts/ci/check-release-runtime.mjs` · inspect |
| 发布构建拒绝 Chromium 的远程调试开关（没有对应的 fuse） | 自动化 | Vitest `apps/desktop/src/main/security/runtime-switches.test.ts` · THR-12 removes and reports the remote debugging switches and nothing else<br>CI `scripts/ci/check-release-runtime.mjs` · remote-debugging-port |
| Agent Host 用内置 node 启动，命令环境去掉 Electron 与 Node 的内部变量 | 自动化 | Rust `crates/piarc-core/src/agent_host.rs` · host_config_puts_the_bundled_node_first_on_path<br>Rust `crates/piarc-core/tests/exec_commands.rs` · the_environment_has_no_internal_variables |

## THR-13 恶意链接与导航

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 导航与重定向只允许应用自身的 origin | 自动化 | Vitest `apps/desktop/src/main/security/navigation.test.ts` · blocks other origins, including look-alike prefixes<br>Vitest `apps/desktop/src/main/security/navigation.test.ts` · THR-13 cancels main-frame, subframe and redirect navigations away from the app origin<br>L4 `apps/desktop/e2e/navigation.e2e.ts` · blocks changing location to an external address<br>L4 `apps/desktop/e2e/navigation.e2e.ts` · blocks a redirect from an app page to an external address |
| 主进程只受理绑定于发起页面的临时工具窗口凭据；普通 window.open 与 target=_blank 被拒 | 自动化 | L4 `apps/desktop/e2e/external-links.e2e.ts` · denies window.open and target=_blank links<br>Vitest `apps/desktop/src/main/tool-windows.test.ts` · THR-13 restricts each native tool ticket to one page, document and use |
| 外链经主进程原生确认，只放行 https、http、mailto 且不带用户信息 | 自动化 | Vitest `apps/desktop/src/main/external-links.test.ts` · rejects every other scheme<br>Vitest `apps/desktop/src/main/external-links.test.ts` · rejects URLs with user information, which hide the real host<br>L4 `apps/desktop/e2e/external-links.e2e.ts` · rejects javascript:, file: and other schemes without asking<br>L4 `apps/desktop/e2e/t34-terminal.e2e.ts` · OSC 8 links and plain URLs show their address and open only when confirmed<br>L4 `apps/desktop/e2e/t34-terminal-windows.e2e.ts` · the find bar counts matches; links open only when confirmed<br>L4 `apps/desktop/e2e/t45-xss.e2e.ts` · THR-13 OSC 8 links with script and data targets in the terminal neither open nor navigate<br>L4 `apps/desktop/e2e/transcript-security.e2e.ts` · opens links only through the main process confirmation |
| piarc:// 链接只做定位，不带可执行内容，不打开网络共享与设备路径 | 自动化 | Vitest `apps/desktop/src/main/launch.test.ts` · carry nothing that runs<br>Vitest `apps/desktop/src/main/launch.test.ts` · THR-13 open no network share or device path, which would make Core reach another host |

## THR-14 同一用户的进程向 PiArc 注入代码

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 应用开启 hardened runtime，entitlements 只有两项 | 自动化 | CI `scripts/ci/check-app-layout.mjs`<br>Vitest `scripts/ci/check-app-layout.test.mjs` · reads an ad-hoc signature with the hardened runtime<br>Vitest `scripts/ci/check-app-layout.test.mjs` · THR-14 the app asks for only JIT and disabled library validation |
| Agent Host 只收到白名单环境变量 | 自动化 | Rust `crates/piarc-host/src/config.rs` · passes_only_named_variables_and_the_fixed_ones |
| 同一用户的进程调试附加 Agent Host | 已接受风险 | 理由：去掉 get-task-allow 要对 node 重签，违背 ADR-0018 保留官方签名的决定；能调试附加的进程已以用户身份运行<br>依据：ADR-0018、I39 |

## THR-15 恶意仓库的 Git 配置

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 只读查询不运行仓库配置的任何程序；只读环境去掉继承的 GIT_* 变量与凭据 | 自动化 | Rust `crates/piarc-git/tests/panel.rs` · thr15_readonly_git_runs_no_repo_program<br>Rust `crates/piarc-git/src/env.rs` · read_only_takes_config_location_and_drops_git_variables |
| 未受信任的项目可以读状态，写操作返回 untrusted；受信任后提交照常运行仓库的 hook | 自动化 | Rust `crates/piarc-testkit/tests/sessions/git.rs` · status_reads_and_writes_wait_for_trust_and_idle_sessions<br>Rust `crates/piarc-git/tests/writes.rs` · commits_run_hooks_and_report_identity |
| 用户模式的环境只加 SSH agent 与代理变量、关闭凭据提示；URL 中的用户信息被脱敏 | 自动化 | Rust `crates/piarc-git/src/env.rs` · user_mode_adds_agents_and_proxies_only<br>Rust `crates/piarc-telemetry/src/redact_tests.rs` · secret_named_fields_and_url_passwords_are_replaced |
| 只有丢失工作的操作需要原生确认，取消时不发送，确认后带上展示的期望提交；远程动过时推送被拒；受保护分支按整名匹配 | 自动化 | Vitest `apps/desktop/src/main/core/git-ipc.test.ts` · confirms only operations that lose work<br>Vitest `apps/desktop/src/main/core/git-ipc.test.ts` · asks natively, sends nothing on cancel and passes the shown lease on confirm<br>Rust `crates/piarc-git/tests/writes.rs` · pushes_are_rejected_leased_and_pulls_stop_on_conflicts<br>Rust `crates/piarc-core/src/git/mod.rs` · protected_patterns_match_whole_names<br>L4 `apps/desktop/e2e/git-panel.e2e.ts` · rolling back asks natively, keeps the bytes and undoes |

## THR-16 浏览器外传与本机服务访问

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 没有运行中的调用时不询问；新主机的文档问一次 Core，本会话的答复覆盖同时等待的主机；未获准的子资源被拦截并进结果；卡片随运行结束撤下 | 自动化 | Vitest `apps/desktop/src/main/browser/agent-gate.test.ts` · refuses unallowed subresources and records them for the result<br>Vitest `apps/desktop/src/main/browser/agent-gate.test.ts` · asks Core for a document and keeps a session answer for every waiting host<br>Vitest `apps/desktop/src/main/browser/agent-gate.test.ts` · refuses a document when Core refuses, and without a run asks nothing<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_site.rs` · without_a_running_call_nothing_is_asked<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_site.rs` · the_card_goes_away_with_the_run_and_on_timeout<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_site.rs` · plan_mode_allows_only_local_addresses<br>L4 `apps/desktop/e2e/browser-agent.e2e.ts` · B2.6: the gate blocks what the user did not allow and reports it |
| 用户打开过的本机端口与会话进程树监听、启动配置声明的端口免卡片，其他本机端口要卡片；浏览器代理拒绝 PiArc 自己的端口 | 自动化 | Vitest `apps/desktop/src/main/browser/agent-gate.test.ts` · lets local ports the user opened through without a card<br>Vitest `apps/desktop/src/main/browser/agent-gate.test.ts` · lets the session’s listening and declared ports through and asks for others (B2.6.2)<br>Rust `crates/piarc-sandbox/tests/proxy.rs` · thr16_a_browser_proxy_refuses_piarc_ports_and_takes_a_new_policy |
| 浏览器代理按名称放行公网与内网，本机地址只在本机名称后可达；请求规则拒绝链路本地与不支持的协议；工作区协议拒绝越界路径 | 自动化 | Rust `crates/piarc-sandbox/tests/proxy.rs` · thr16_a_browser_proxy_lets_any_public_or_private_name_through_without_asking<br>Rust `crates/piarc-sandbox/tests/proxy.rs` · thr16_a_browser_proxy_reaches_loopback_only_behind_local_names<br>Vitest `apps/desktop/src/main/browser/request-rules.test.ts` · THR-16 refuses %s (%s)<br>Vitest `apps/desktop/src/main/browser/workspace-files.test.ts` · THR-16 refuses %s |
| 宿主页面的 CSP 不许连接、宿主分区的请求全部取消；CDP 代理只答本 Space 的目标，允许名单外的方法被拒并记入结果 | 自动化 | Vitest `apps/desktop/src/main/browser/host-session.test.ts` · allows scripts only from the host and no connections<br>Vitest `apps/desktop/src/main/browser/cdp-policy.test.ts` · answers the Space-scoped Target methods and the version only<br>Vitest `apps/desktop/src/main/browser/cdp-proxy.test.ts` · refuses methods outside the policy and records them<br>L4 `apps/desktop/e2e/browser-agent.e2e.ts` · THR-05: the script host reaches nothing on the network |
| 工作区外的上传要卡片、deny 规则拒绝；没有运行中的调用不搬运；保存在手动模式询问、不覆盖、只认本会话的下载；保存与下载的文件带 quarantine 或 Zone.Identifier | 自动化 | Rust `crates/piarc-core/src/tool_io/policy/tests/browser_files.rs` · a_file_outside_the_workspace_asks_and_a_deny_rule_refuses<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_files.rs` · nothing_moves_without_a_running_call<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_files.rs` · saving_asks_in_manual_mode_and_never_replaces_a_file<br>Vitest `apps/desktop/src/main/browser/quarantine.test.ts` · adds the macOS attribute when the download has none<br>Vitest `apps/desktop/src/main/browser/quarantine.test.ts` · writes the Windows zone stream without credentials or line breaks<br>L4 `apps/desktop/e2e/browser-files.e2e.ts` · B2.6.6 a download the agent saves asks first and lands in the workspace, quarantined |

## THR-17 浏览器凭据

| 对策 | 类型 | 测试与依据 |
|---|---|---|
| 标签加载在工作区自己的分区里，没有 preload、拿不到应用的 IPC | 自动化 | L4 `apps/desktop/e2e/browser-basic.e2e.ts` · THR-11 guests reach neither the preload nor Node |
| 默认不勾任何站点、没有"全部"；取消原生确认不导入；导入的站点及其子域名对智能体是敏感站点，allow 规则与跳过权限都不放行，读不到记录时也按敏感处理 | 自动化 | L4 `apps/desktop/e2e/browser-import.e2e.ts` · THR-17 imports chosen sites after the native confirmation; the page never sees a value<br>Vitest `apps/desktop/src/main/browser/agent-gate-imports.test.ts` · THR-17 marks the imported site and its subdomains sensitive, not other sites<br>Vitest `apps/desktop/src/main/browser/agent-gate-imports.test.ts` · THR-17 counts a host as imported when the records cannot be read<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_import.rs` · thr17_an_allow_rule_does_not_cover_an_imported_site<br>Rust `crates/piarc-core/src/tool_io/policy/tests/browser_import.rs` · thr17_bypass_permissions_asks_for_an_imported_site |
| 页面只拿到每站点的条数；值登记到日志脱敏、审计只记站点与条数；密钥不打印字节，明文缓冲用后清零 | 自动化 | Vitest `apps/desktop/src/main/browser/chrome-import.test.ts` · THR-17 the page gets counts only: confirms natively, imports through Core, writes the cookies<br>Rust `crates/piarc-core/src/browser/import.rs` · thr17_import_redacts_values_and_audits_sites_and_counts_only<br>Rust `crates/piarc-browser-import/src/crypto.rs` · thr17_keys_do_not_print_their_bytes<br>Rust `crates/piarc-browser-import/src/crypto.rs` · thr17_plaintext_buffers_are_zeroized<br>Rust `crates/piarc-browser-import/src/import.rs` · thr17_macos_v10_import_with_domain_hash_keeps_values_out_of_debug |
| Windows 上浏览器分区的 cookie 对沙箱外的同用户进程不保密 | 已接受风险 | Vitest `apps/desktop/src/main/browser/chrome-import.test.ts` · removes a site: its cookies first, then the record<br>理由：Windows 到 Beta 没有 OS 级沙箱（D7），经批准的命令与同用户进程可以用 DPAPI 解开分区里的 cookie；用户在听过风险后坚持保留导入功能，设置页可按站点移除导入、清除工作区浏览数据或改为退出即清空<br>依据：ADR-0090、ADR-0057 |
