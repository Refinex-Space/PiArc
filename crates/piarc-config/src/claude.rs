//! Claude Code configuration, read only (ADR-0005): the key mapping table, the files PiArc
//! reads, and the guard that keeps every PiArc write out of them.
//!
//! [`SETTINGS_KEYS`] is the one place that decides what a key of a Claude Code settings file
//! does in PiArc. The merge keeps exactly the keys marked [`KeyStatus::Active`]
//! ([`project`]); the configuration diagnostics classify every key of a file with the same
//! table ([`classify`]). A later task that implements a key's feature changes its row from
//! `Planned` to `Active` (and adds the key to PiArc's settings schema); it does not add a
//! second decision anywhere else.
//!
//! The rows follow the settings index of the official reference
//! (<https://code.claude.com/docs/en/settings-reference>, read 2026-11-18). Keys not in the
//! table are reported as unknown and ignored.

use std::path::{Component, Path};

use serde_json::{Map, Value};

use crate::schema::push_token;

/// Claude Code's directory, in a workspace and in the home directory.
pub const CLAUDE_DIR: &str = ".claude";

/// Claude Code's own state file in the home directory.
pub const CLAUDE_STATE_FILE: &str = ".claude.json";

/// What a Claude Code key does in PiArc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    /// Merged into PiArc's settings under the same JSON Pointer.
    Active,
    /// Not used yet; the named task implements the feature.
    Planned(&'static str),
    /// Never used by PiArc.
    Ignored,
}

/// One row of the mapping table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaudeKey {
    /// The key, dotted for nested keys (`permissions.allow`). A row covers the key's whole
    /// value unless rows for its children exist.
    pub key: &'static str,
    /// What PiArc does with it.
    pub status: KeyStatus,
    /// The PiArc setting (`Active`) or feature (`Planned`) it corresponds to; for `Ignored`
    /// rows, why.
    pub target: &'static str,
}

const fn active(key: &'static str, target: &'static str) -> ClaudeKey {
    ClaudeKey {
        key,
        status: KeyStatus::Active,
        target,
    }
}

const fn planned(key: &'static str, task: &'static str, target: &'static str) -> ClaudeKey {
    ClaudeKey {
        key,
        status: KeyStatus::Planned(task),
        target,
    }
}

const fn ignored(key: &'static str, why: &'static str) -> ClaudeKey {
    ClaudeKey {
        key,
        status: KeyStatus::Ignored,
        target: why,
    }
}

const MANAGED: &str = "managed settings only";
const GLOBAL: &str = "global config key of ~/.claude.json";
const UI: &str = "Claude Code terminal or app preference";
const ACCOUNT: &str = "Anthropic account, login or telemetry";
const NONE: &str = "no corresponding PiArc feature";

/// The mapping table of `settings.json` keys (`~/.claude/settings.json`,
/// `.claude/settings.json`, `.claude/settings.local.json`).
pub const SETTINGS_KEYS: &[ClaudeKey] = &[
    ignored("$schema", "editor schema reference"),
    planned("advisorModel", "T31", "model aliases"),
    planned("agent", "T31", "subagents"),
    ignored("agentPushNotifEnabled", UI),
    ignored("allowAllClaudeAiMcps", MANAGED),
    ignored("allowClaudeInChromeWithManagedMcp", MANAGED),
    ignored("allowedChannelPlugins", MANAGED),
    planned("allowedHttpHookUrls", "T38", "http hooks"),
    planned("allowedMcpServers", "T36", "MCP servers"),
    ignored("allowedProviders", MANAGED),
    ignored("allowManagedHooksOnly", MANAGED),
    ignored("allowManagedMcpServersOnly", MANAGED),
    ignored("allowManagedPermissionRulesOnly", MANAGED),
    ignored("alwaysThinkingEnabled", NONE),
    ignored("apiKeyHelper", ACCOUNT),
    ignored("appendPlugins", NONE),
    ignored("askUserQuestionTimeout", NONE),
    ignored("attribution", NONE),
    active("autoCompactEnabled", "/autoCompactEnabled"),
    active("autoCompactWindow", "/autoCompactWindow"),
    ignored("autoConnectIde", GLOBAL),
    ignored("autoContinueAtUsageLimit", ACCOUNT),
    ignored("autoInstallIdeExtension", GLOBAL),
    planned("autoMemoryDirectory", "T47", "auto memory"),
    planned("autoMemoryEnabled", "T47", "auto memory"),
    planned("autoMode", "T46", "auto mode"),
    ignored("autoScrollEnabled", UI),
    ignored("autoUpdatesChannel", NONE),
    ignored("availableModels", NONE),
    ignored("availableModelsMatch", MANAGED),
    ignored("awaySummaryEnabled", UI),
    ignored("awsAuthRefresh", ACCOUNT),
    ignored("awsCredentialExport", ACCOUNT),
    ignored("axScreenReader", UI),
    ignored("bashEditDiffEnabled", UI),
    ignored("bashOutputMaxChars", NONE),
    ignored("blockedMarketplaces", MANAGED),
    ignored("browserExternalPageTools", MANAGED),
    ignored("channelsEnabled", MANAGED),
    ignored("claudeInChromeDefaultEnabled", GLOBAL),
    ignored("claudeMd", MANAGED),
    ignored("claudeMdExcludes", NONE),
    ignored("cleanupPeriodDays", NONE),
    ignored("companyAnnouncements", UI),
    ignored("copyFullResponse", GLOBAL),
    ignored("copyOnSelect", GLOBAL),
    ignored("crossSessionInbound", NONE),
    ignored("defaultShell", NONE),
    ignored("defaultToAgentsView", GLOBAL),
    planned("deniedMcpServers", "T36", "MCP servers"),
    ignored("deniedModels", MANAGED),
    ignored("desktopSessionCleanupPeriodDays", NONE),
    ignored("dialogExpiry", UI),
    ignored("diffTool", GLOBAL),
    ignored("disableAgentView", UI),
    active("disableAllHooks", "/disableAllHooks"),
    ignored("disableArtifact", NONE),
    planned("disableAutoMode", "T46", "auto mode"),
    ignored("disableBrowserExternalNavigation", MANAGED),
    planned("disableBundledSkills", "T37", "skills"),
    ignored("disableClaudeAiConnectors", ACCOUNT),
    ignored("disableCommandPluginSources", MANAGED),
    ignored("disableDeepLinkRegistration", NONE),
    ignored("disableDesktopLocalSessions", MANAGED),
    planned("disabledMcpjsonServers", "T36", "MCP servers"),
    ignored("disableMobileSimulatorTools", MANAGED),
    ignored("disableRemoteControl", NONE),
    ignored("disableRemotePreviewScripts", MANAGED),
    ignored("disableSideloadFlags", MANAGED),
    planned("disableSkillShellExecution", "T37", "skills"),
    ignored("disableWorkflows", NONE),
    ignored("editorMode", UI),
    planned("effortLevel", "T29", "model settings"),
    ignored("emojiCompletionEnabled", UI),
    planned("enableAllProjectMcpServers", "T36", "MCP servers"),
    ignored("enableArtifact", NONE),
    planned("enabledMcpjsonServers", "T36", "MCP servers"),
    planned("enabledPlugins", "T40", "plugins"),
    ignored("enableWorkflows", NONE),
    ignored("enforceAvailableModels", NONE),
    ignored(
        "env",
        "commands get the login shell environment admitted by ADR-0035",
    ),
    ignored("externalEditorContext", GLOBAL),
    planned("extraKnownMarketplaces", "T40", "plugins"),
    ignored("fallbackModel", NONE),
    ignored("fastMode", NONE),
    ignored("fastModePerSessionOptIn", NONE),
    ignored("feedbackDrafts", ACCOUNT),
    ignored("feedbackSurveyRate", ACCOUNT),
    active("fileCheckpointingEnabled", "/fileCheckpointingEnabled"),
    ignored("fileSuggestion", UI),
    ignored("footerLinksRegexes", UI),
    ignored("forceLoginGatewayUrl", ACCOUNT),
    ignored("forceLoginMethod", ACCOUNT),
    ignored("forceLoginOrgUUID", ACCOUNT),
    ignored("forceRemoteSettingsRefresh", MANAGED),
    ignored("gatewayInternalNetworks", MANAGED),
    ignored("gcpAuthRefresh", ACCOUNT),
    active("hooks", "/hooks"),
    planned("httpHookAllowedEnvVars", "T38", "http hooks"),
    ignored("idleCompaction", NONE),
    ignored("includeCoAuthoredBy", NONE),
    ignored("includeGitInstructions", NONE),
    ignored("inputNeededNotifEnabled", UI),
    ignored("isolatePeerMachines", NONE),
    ignored("keybindingFlavor", UI),
    ignored("language", "PiArc has its own language preference"),
    ignored("leftArrowOpensAgents", GLOBAL),
    ignored("managedMcpServers", MANAGED),
    ignored("managedSourcesBehavior", MANAGED),
    ignored("maxEffortLevel", NONE),
    ignored("maxProseWidth", UI),
    ignored("minimumVersion", NONE),
    planned("model", "T29", "model settings"),
    ignored("modelOverrides", NONE),
    ignored("modelPicker", UI),
    ignored("modelPricing", MANAGED),
    ignored("modelSettings", NONE),
    ignored("otelHeadersHelper", ACCOUNT),
    planned("outputStyle", "T37", "output styles"),
    ignored("parentSettingsBehavior", MANAGED),
    ignored("permissionExplainerEnabled", GLOBAL),
    active(
        "permissions.additionalDirectories",
        "/permissions/additionalDirectories",
    ),
    active("permissions.allow", "/permissions/allow"),
    active("permissions.ask", "/permissions/ask"),
    ignored("permissions.blockReadsOutsideWorkingDirectories", NONE),
    ignored("permissions.blockWritesOutsideWorkingDirectories", NONE),
    active("permissions.defaultMode", "/permissions/defaultMode"),
    active("permissions.deny", "/permissions/deny"),
    ignored("permissions.denyInsteadOfPrompting", NONE),
    ignored(
        "permissions.disableBypassPermissionsMode",
        "bypass needs PiArc's own user-level switch",
    ),
    planned("plansDirectory", "T48", "plan files (R3: I104)"),
    ignored("pluginConfigs", NONE),
    ignored("pluginSuggestionMarketplaces", MANAGED),
    ignored("pluginTrustMessage", MANAGED),
    ignored("policyHelper", MANAGED),
    ignored("preferredNotifChannel", UI),
    ignored(
        "prefersReducedMotion",
        "PiArc has its own reduce-motion preference",
    ),
    ignored("prependPlugins", NONE),
    ignored("processWrapper", NONE),
    ignored("promptCacheTtl", NONE),
    ignored("promptSuggestionEnabled", UI),
    ignored("prStatusFooterEnabled", GLOBAL),
    ignored("prUrlTemplate", UI),
    ignored("remote", NONE),
    ignored("remoteControlAtStartup", NONE),
    ignored("requiredMaximumVersion", MANAGED),
    ignored("requiredMinimumVersion", MANAGED),
    ignored("respectGitignore", NONE),
    ignored("respondToBashCommands", NONE),
    planned("sandbox", "T39", "sandbox"),
    ignored("showClearContextOnPlanAccept", UI),
    ignored("showThinkingSummaries", UI),
    ignored("showTurnDuration", UI),
    ignored("skillListingBudgetFraction", NONE),
    ignored("skillListingMaxDescChars", NONE),
    planned("skillOverrides", "T37", "skills"),
    ignored("skipAutoPermissionPrompt", NONE),
    ignored("skipDangerousModePermissionPrompt", NONE),
    ignored("skipWebFetchPreflight", NONE),
    ignored("spellcheck", UI),
    ignored("spinnerTipsEnabled", UI),
    ignored("spinnerTipsOverride", UI),
    ignored("spinnerVerbs", UI),
    ignored("sshConfigs", NONE),
    ignored("sshHostAllowlist", MANAGED),
    ignored("sshHostCommands", NONE),
    ignored("statusLine", UI),
    ignored("strictKnownMarketplaces", MANAGED),
    ignored("strictPluginOnlyCustomization", MANAGED),
    ignored("subagentPromptCacheTtl", NONE),
    ignored("switchModelsOnFlag", NONE),
    ignored("syncClaudeAiPlugins", ACCOUNT),
    ignored("syncClaudeAiSkills", ACCOUNT),
    ignored("syntaxHighlightingDisabled", UI),
    ignored("taskOutputMaxChars", NONE),
    ignored("teammateDefaultModel", GLOBAL),
    ignored("teammateMode", NONE),
    ignored("terminalProgressBarEnabled", UI),
    ignored("terminalTitleFromRename", UI),
    ignored("theme", "PiArc has its own theme preference"),
    ignored("timeFormat", UI),
    ignored("timeZone", UI),
    ignored("tui", UI),
    ignored("ultracode", NONE),
    planned("useAutoModeDuringPlan", "T46", "auto mode"),
    ignored("verbose", UI),
    ignored("viewMode", UI),
    ignored("vimInsertModeRemaps", UI),
    ignored("voice", UI),
    ignored("voiceEnabled", UI),
    ignored("wheelScrollAccelerationEnabled", UI),
    ignored("workflowKeywordTriggerEnabled", NONE),
    ignored("workflowSizeGuideline", NONE),
    planned("worktree", "T35", "worktrees"),
    ignored("wslInheritsWindowsSettings", MANAGED),
];

/// The mapping table of `~/.claude.json`: only its MCP servers concern PiArc (T36); the rest
/// is Claude Code's own state.
pub const STATE_KEYS: &[ClaudeKey] = &[planned("mcpServers", "T36", "MCP servers")];

/// How one key of a file was classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyClass {
    /// JSON Pointer of the key in the file.
    pub pointer: String,
    /// `None` for a key the table does not know (ignored).
    pub row: Option<&'static ClaudeKey>,
}

impl KeyClass {
    /// The status; an unknown key is ignored.
    #[must_use]
    pub fn status(&self) -> KeyStatus {
        self.row.map_or(KeyStatus::Ignored, |r| r.status)
    }
}

/// Every key of `value` (a settings object) classified with `table`, in key order. A key
/// whose row has children rows is descended into; any other key is one entry.
#[must_use]
pub fn classify(value: &Value, table: &'static [ClaudeKey]) -> Vec<KeyClass> {
    let mut out = Vec::new();
    if let Some(map) = value.as_object() {
        walk(map, "", &mut String::new(), table, &mut out);
    }
    out
}

fn walk(
    map: &Map<String, Value>,
    prefix: &str,
    pointer: &mut String,
    table: &'static [ClaudeKey],
    out: &mut Vec<KeyClass>,
) {
    for (key, value) in map {
        let dotted = format!("{prefix}{key}");
        let len = pointer.len();
        push_token(pointer, key);
        let children = format!("{dotted}.");
        let has_children = table.iter().any(|r| r.key.starts_with(&children));
        match value.as_object() {
            Some(child) if has_children => walk(child, &children, pointer, table, out),
            _ => out.push(KeyClass {
                pointer: pointer.clone(),
                row: table.iter().find(|r| r.key == dotted),
            }),
        }
        pointer.truncate(len);
    }
}

/// The part of a Claude Code settings value PiArc merges: the [`KeyStatus::Active`] keys, at
/// the same pointers.
#[must_use]
pub fn project(value: &Value) -> Value {
    let mut out = Value::Object(Map::new());
    for class in classify(value, SETTINGS_KEYS) {
        if class.status() != KeyStatus::Active {
            continue;
        }
        if let Some(found) = value.pointer(&class.pointer) {
            insert(&mut out, &class.pointer, found.clone());
        }
    }
    out
}

fn insert(document: &mut Value, pointer: &str, value: Value) {
    let tokens: Vec<String> = pointer
        .split('/')
        .skip(1)
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let Some((last, parents)) = tokens.split_last() else {
        return;
    };
    let mut current = document;
    for token in parents {
        let Value::Object(map) = current else {
            return;
        };
        current = map
            .entry(token.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if let Value::Object(map) = current {
        map.insert(last.clone(), value);
    }
}

/// Whether `path` is inside a `.claude` directory or is a `.claude.json` file: PiArc never
/// writes there (ADR-0005 rule 2).
#[must_use]
pub fn is_claude_path(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.eq_ignore_ascii_case(CLAUDE_DIR) || name.eq_ignore_ascii_case(CLAUDE_STATE_FILE)
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn table_rows_are_unique_and_sorted_within_their_parent() {
        let mut seen = std::collections::BTreeSet::new();
        for row in SETTINGS_KEYS.iter().chain(STATE_KEYS) {
            assert!(seen.insert(row.key), "duplicate row {}", row.key);
            assert!(!row.target.is_empty(), "{} has no target", row.key);
        }
    }

    #[test]
    fn active_rows_point_at_piarc_settings_of_the_same_name() {
        use crate::schema::{PIARC_SETTINGS, validate};
        for row in SETTINGS_KEYS
            .iter()
            .filter(|r| r.status == KeyStatus::Active)
        {
            assert_eq!(row.target, format!("/{}", row.key.replace('.', "/")));
            // A known key of PiArc's schema: an unknown key would only be a warning.
            let mut probe = Value::Object(Map::new());
            insert(&mut probe, row.target, Value::Null);
            let findings = validate(&probe, &PIARC_SETTINGS);
            assert!(
                findings.iter().all(|f| !f.message.contains("unknown key")),
                "{} is not a PiArc setting: {findings:?}",
                row.key
            );
        }
    }

    #[test]
    fn keys_are_classified_and_only_active_ones_projected() {
        let value = json!({
            "permissions": { "allow": ["Bash(ls)"], "deny": ["Read(.env)"], "disableBypassPermissionsMode": "disable", "mystery": 1 },
            "hooks": { "PreToolUse": [] },
            "sandbox": { "enabled": true },
            "theme": "dark",
            "notAKey": true
        });
        let classes: Vec<(String, KeyStatus, bool)> = classify(&value, SETTINGS_KEYS)
            .into_iter()
            .map(|c| (c.pointer.clone(), c.status(), c.row.is_some()))
            .collect();
        assert_eq!(
            classes,
            [
                ("/hooks".to_owned(), KeyStatus::Active, true),
                ("/notAKey".to_owned(), KeyStatus::Ignored, false),
                ("/permissions/allow".to_owned(), KeyStatus::Active, true),
                ("/permissions/deny".to_owned(), KeyStatus::Active, true),
                (
                    "/permissions/disableBypassPermissionsMode".to_owned(),
                    KeyStatus::Ignored,
                    true
                ),
                ("/permissions/mystery".to_owned(), KeyStatus::Ignored, false),
                ("/sandbox".to_owned(), KeyStatus::Planned("T39"), true),
                ("/theme".to_owned(), KeyStatus::Ignored, true),
            ]
        );
        assert_eq!(
            project(&value),
            json!({ "hooks": { "PreToolUse": [] }, "permissions": { "allow": ["Bash(ls)"], "deny": ["Read(.env)"] } })
        );
        // A wrongly typed parent is one ignored entry and contributes nothing.
        let wrong = json!({ "permissions": ["Bash(ls)"] });
        assert_eq!(classify(&wrong, SETTINGS_KEYS)[0].pointer, "/permissions");
        assert_eq!(project(&wrong), json!({}));
    }

    #[test]
    fn claude_paths_are_recognised_on_every_component() {
        for path in [
            "/w/.claude/settings.json",
            "/h/.claude.json",
            "/w/.CLAUDE/rules/x.md",
            "rel/.claude",
        ] {
            assert!(is_claude_path(Path::new(path)), "{path}");
        }
        for path in [
            "/w/.piarc/settings.json",
            "/w/claude/x",
            "/w/.claude-plugin/a",
        ] {
            assert!(!is_claude_path(Path::new(path)), "{path}");
        }
    }
}
