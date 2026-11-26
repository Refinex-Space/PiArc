//! A small structural schema for settings files: enough to report the JSON Pointer and the
//! reason of every wrong value, and unknown keys as warnings.

use serde_json::Value;

/// The expected shape of a JSON value.
#[derive(Debug)]
pub enum Shape {
    /// Anything.
    Any,
    /// `true` or `false`.
    Bool,
    /// A number.
    Number,
    /// A string.
    String,
    /// One of the listed strings.
    OneOf(&'static [&'static str]),
    /// A list whose items have the shape.
    ListOf(&'static Shape),
    /// An object with known keys; other keys are reported as unknown (warnings).
    Object(&'static [Field]),
    /// An object with any keys whose values have the shape.
    MapOf(&'static Shape),
}

/// A known key of an [`Shape::Object`].
#[derive(Debug)]
pub struct Field {
    /// The key.
    pub name: &'static str,
    /// Its value's shape.
    pub shape: Shape,
}

/// How bad an issue is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The file is not used.
    Error,
    /// The file is used; the key is ignored.
    Warning,
}

/// One finding in a value, before it is tied to a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// JSON Pointer of the value (`""` for the whole document).
    pub pointer: String,
    /// What is wrong.
    pub message: String,
    /// Error or warning.
    pub severity: Severity,
}

/// Checks `value` against `shape`; findings are in document order.
#[must_use]
pub fn validate(value: &Value, shape: &Shape) -> Vec<Finding> {
    let mut findings = Vec::new();
    check(value, shape, &mut String::new(), &mut findings);
    findings
}

fn check(value: &Value, shape: &Shape, pointer: &mut String, out: &mut Vec<Finding>) {
    let wrong = |out: &mut Vec<Finding>, pointer: &str, expected: &str| {
        out.push(Finding {
            pointer: pointer.to_owned(),
            message: format!("expected {expected}, found {}", type_name(value)),
            severity: Severity::Error,
        });
    };
    match shape {
        Shape::Any => {}
        Shape::Bool if !value.is_boolean() => wrong(out, pointer, "a boolean"),
        Shape::Number if !value.is_number() => wrong(out, pointer, "a number"),
        Shape::String if !value.is_string() => wrong(out, pointer, "a string"),
        Shape::OneOf(allowed) => match value.as_str() {
            Some(text) if allowed.contains(&text) => {}
            Some(text) => out.push(Finding {
                pointer: pointer.clone(),
                message: format!("{text:?} is not one of {}", allowed.join(", ")),
                severity: Severity::Error,
            }),
            None => wrong(out, pointer, "a string"),
        },
        Shape::ListOf(item) => match value.as_array() {
            Some(items) => {
                for (index, element) in items.iter().enumerate() {
                    let len = pointer.len();
                    pointer.push('/');
                    pointer.push_str(&index.to_string());
                    check(element, item, pointer, out);
                    pointer.truncate(len);
                }
            }
            None => wrong(out, pointer, "a list"),
        },
        Shape::Object(fields) => match value.as_object() {
            Some(map) => {
                for (key, element) in map {
                    let len = pointer.len();
                    push_token(pointer, key);
                    match fields.iter().find(|f| f.name == key) {
                        Some(field) => check(element, &field.shape, pointer, out),
                        None => out.push(Finding {
                            pointer: pointer.clone(),
                            message: format!("unknown key {key:?} is ignored"),
                            severity: Severity::Warning,
                        }),
                    }
                    pointer.truncate(len);
                }
            }
            None => wrong(out, pointer, "an object"),
        },
        Shape::MapOf(item) => match value.as_object() {
            Some(map) => {
                for (key, element) in map {
                    let len = pointer.len();
                    push_token(pointer, key);
                    check(element, item, pointer, out);
                    pointer.truncate(len);
                }
            }
            None => wrong(out, pointer, "an object"),
        },
        Shape::Bool | Shape::Number | Shape::String => {}
    }
}

/// Appends `/<key>` with JSON Pointer escaping (`~` → `~0`, `/` → `~1`).
pub fn push_token(pointer: &mut String, key: &str) {
    pointer.push('/');
    for c in key.chars() {
        match c {
            '~' => pointer.push_str("~0"),
            '/' => pointer.push_str("~1"),
            c => pointer.push(c),
        }
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// Permission modes (architecture section 6.2.1).
pub const PERMISSION_MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "auto",
    "dontAsk",
];

const STRINGS: Shape = Shape::String;

const HOOK_HANDLER: Shape = Shape::Object(&[
    Field {
        name: "type",
        shape: Shape::OneOf(&["command", "prompt", "agent", "http", "mcp_tool"]),
    },
    Field {
        name: "command",
        shape: Shape::String,
    },
    Field {
        name: "args",
        shape: Shape::ListOf(&STRINGS),
    },
    Field {
        name: "shell",
        shape: Shape::OneOf(&["bash", "powershell"]),
    },
    Field {
        name: "if",
        shape: Shape::String,
    },
    Field {
        name: "onFailure",
        shape: Shape::OneOf(&["continue", "block"]),
    },
    Field {
        name: "prompt",
        shape: Shape::String,
    },
    Field {
        name: "model",
        shape: Shape::String,
    },
    Field {
        name: "url",
        shape: Shape::String,
    },
    Field {
        name: "headers",
        shape: Shape::Any,
    },
    Field {
        name: "allowedEnvVars",
        shape: Shape::ListOf(&STRINGS),
    },
    Field {
        name: "continueOnBlock",
        shape: Shape::Bool,
    },
    Field {
        name: "server",
        shape: Shape::String,
    },
    Field {
        name: "tool",
        shape: Shape::String,
    },
    Field {
        name: "input",
        shape: Shape::Any,
    },
    Field {
        name: "timeout",
        shape: Shape::Number,
    },
    Field {
        name: "async",
        shape: Shape::Bool,
    },
    Field {
        name: "asyncRewake",
        shape: Shape::Bool,
    },
    Field {
        name: "once",
        shape: Shape::Bool,
    },
    Field {
        name: "statusMessage",
        shape: Shape::String,
    },
]);

const HOOK_MATCHER: Shape = Shape::Object(&[
    Field {
        name: "matcher",
        shape: Shape::String,
    },
    Field {
        name: "hooks",
        shape: Shape::ListOf(&HOOK_HANDLER),
    },
]);

const HOOK_GROUPS: Shape = Shape::ListOf(&HOOK_MATCHER);

/// One entry of `allowedMcpServers` or `deniedMcpServers` (T47): exactly one of the three keys
/// (checked by `crate::mcp::policy`).
const MCP_POLICY_ENTRY: Shape = Shape::Object(&[
    Field {
        name: "serverName",
        shape: Shape::String,
    },
    Field {
        name: "serverCommand",
        shape: Shape::ListOf(&STRINGS),
    },
    Field {
        name: "serverUrl",
        shape: Shape::String,
    },
]);

/// The PiArc settings file (`settings.json` in the data directory, `.piarc/settings.json`,
/// `.piarc/settings.local.json`), first version. Hooks use Claude Code's format (ADR-0005);
/// their meaning is T25's, permission rules are T20's and T23's.
pub const PIARC_SETTINGS: Shape = Shape::Object(&[
    Field {
        name: "memory",
        shape: Shape::Object(&[Field {
            name: "readBoth",
            shape: Shape::Bool,
        }]),
    },
    Field {
        name: "modelProviders",
        shape: Shape::Any,
    },
    // Read by Core from the user's file only (T41): `<provider>/<model>` → the user's prices in
    // USD per million tokens, replacing the catalog's for usage costs.
    Field {
        name: "modelPrices",
        shape: Shape::MapOf(&Shape::Object(&[
            Field {
                name: "input",
                shape: Shape::Number,
            },
            Field {
                name: "output",
                shape: Shape::Number,
            },
            Field {
                name: "cacheRead",
                shape: Shape::Number,
            },
            Field {
                name: "cacheWrite",
                shape: Shape::Number,
            },
        ])),
    },
    Field {
        name: "$schema",
        shape: Shape::String,
    },
    // The default model of new sessions: `<provider>/<model id>` or an alias (T31; Claude
    // Code's key of the same name).
    Field {
        name: "model",
        shape: Shape::String,
    },
    // The default effort of new sessions (T31; Claude Code's key of the same name).
    Field {
        name: "effortLevel",
        shape: Shape::OneOf(&["low", "medium", "high", "xhigh", "max"]),
    },
    // The model alias table (T31, architecture section 6.13): alias → `<provider>/<model id>`.
    // `haiku`, `sonnet` and `opus` follow `fast`, `balanced` and `strong` unless set.
    Field {
        name: "modelAliases",
        shape: Shape::Object(&[
            Field {
                name: "fast",
                shape: Shape::String,
            },
            Field {
                name: "balanced",
                shape: Shape::String,
            },
            Field {
                name: "strong",
                shape: Shape::String,
            },
            Field {
                name: "haiku",
                shape: Shape::String,
            },
            Field {
                name: "sonnet",
                shape: Shape::String,
            },
            Field {
                name: "opus",
                shape: Shape::String,
            },
        ]),
    },
    // Subagent limits (T31): levels below the main session and runs at once per main session.
    Field {
        name: "subagents",
        shape: Shape::Object(&[
            Field {
                name: "maxDepth",
                shape: Shape::Number,
            },
            Field {
                name: "maxConcurrent",
                shape: Shape::Number,
            },
        ]),
    },
    Field {
        name: "permissions",
        shape: Shape::Object(&[
            Field {
                name: "allow",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "ask",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "deny",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "defaultMode",
                shape: Shape::OneOf(PERMISSION_MODES),
            },
            Field {
                name: "additionalDirectories",
                shape: Shape::ListOf(&STRINGS),
            },
            // Read from the user's own file only: shows bypassPermissions in the mode menu.
            Field {
                name: "enableBypassPermissions",
                shape: Shape::Bool,
            },
            // Read from the user's own file only (T46): Auto mode is available.
            Field {
                name: "enableAutoMode",
                shape: Shape::Bool,
            },
        ]),
    },
    // Auto mode (T46): Claude Code's `autoMode` lists, read from the user's two files only;
    // `model` (`provider/model`) only from PiArc's user file.
    Field {
        name: "autoMode",
        shape: Shape::Object(&[
            Field {
                name: "model",
                shape: Shape::String,
            },
            Field {
                name: "environment",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "allow",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "soft_deny",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "hard_deny",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "classifyAllShell",
                shape: Shape::Bool,
            },
        ]),
    },
    // Any layer may turn Auto mode off (T46), as Claude Code's `disableAutoMode`.
    Field {
        name: "disableAutoMode",
        shape: Shape::OneOf(&["disable"]),
    },
    Field {
        name: "hooks",
        shape: Shape::MapOf(&HOOK_GROUPS),
    },
    Field {
        name: "disableAllHooks",
        shape: Shape::Bool,
    },
    // `http` hooks (T38, ADR-0055), Claude Code's keys: URL patterns (`*` wildcard) an `http`
    // hook may post to, and the variables its headers may interpolate. Each list merges across
    // files unless managed settings supply it (ADR-0065).
    Field {
        name: "allowedHttpHookUrls",
        shape: Shape::ListOf(&STRINGS),
    },
    Field {
        name: "httpHookAllowedEnvVars",
        shape: Shape::ListOf(&STRINGS),
    },
    // Read by Core from the user's file only (I93): variables of the login shell's environment
    // that command hooks get besides the commands' environment (ADR-0035).
    Field {
        name: "hookAllowedEnvVars",
        shape: Shape::ListOf(&STRINGS),
    },
    // Read by Core from the user's file only (T38): WebSearch's third-party backend (`brave`);
    // its API key is in the vault.
    Field {
        name: "webSearch",
        shape: Shape::Object(&[Field {
            name: "backend",
            shape: Shape::OneOf(&["brave"]),
        }]),
    },
    // MCP servers (T36, architecture section 6.8): `.mcp.json`'s entry shape, checked entry by
    // entry by `crate::mcp` (a bad entry leaves out that server, not the file). Executable in
    // project files.
    Field {
        name: "mcpServers",
        shape: Shape::MapOf(&Shape::Any),
    },
    // Extension packages (T40, ADR-0058): package id → on or off. The user file declares
    // packages for every workspace, `.piarc/` files for one; executable in project files.
    Field {
        name: "plugins",
        shape: Shape::MapOf(&Shape::Bool),
    },
    // The Bash sandbox (T39, architecture section 6.10), Claude Code's keys with the same
    // meaning: on or off (default off), whether sandboxed commands skip the approval
    // (default false: they are still approved), paths no sandboxed command may read, and the
    // domains the sandbox's proxy lets through. A project file can only tighten: turning the
    // sandbox on and adding `denyRead` apply, `allowedDomains` and auto-approval do not
    // (`crate::sandbox`).
    Field {
        name: "sandbox",
        shape: Shape::Object(&[
            Field {
                name: "enabled",
                shape: Shape::Bool,
            },
            Field {
                name: "autoAllowBashIfSandboxed",
                shape: Shape::Bool,
            },
            Field {
                name: "filesystem",
                shape: Shape::Object(&[Field {
                    name: "denyRead",
                    shape: Shape::ListOf(&STRINGS),
                }]),
            },
            Field {
                name: "network",
                shape: Shape::Object(&[
                    Field {
                        name: "allowedDomains",
                        shape: Shape::ListOf(&STRINGS),
                    },
                    // Managed settings only (T47): the proxy lets through the managed
                    // `allowedDomains` alone and never asks about another domain.
                    Field {
                        name: "allowManagedDomainsOnly",
                        shape: Shape::Bool,
                    },
                ]),
            },
        ]),
    },
    // Claude Code's key: `.mcp.json` servers to leave off, in any settings file.
    Field {
        name: "disabledMcpjsonServers",
        shape: Shape::ListOf(&STRINGS),
    },
    // Claude Code's MCP policy lists (T47), in any settings file: entries name a server
    // (`serverName`), a stdio command line (`serverCommand`) or a URL pattern (`serverUrl`).
    // A deny entry always wins; once any file sets the allowlist, a server must match it.
    Field {
        name: "allowedMcpServers",
        shape: Shape::ListOf(&MCP_POLICY_ENTRY),
    },
    Field {
        name: "deniedMcpServers",
        shape: Shape::ListOf(&MCP_POLICY_ENTRY),
    },
    // Managed settings only (T47, `crate::managed`): run only the managed hooks; take
    // permission rules only from managed settings; take the MCP allowlist only from managed
    // settings.
    Field {
        name: "allowManagedHooksOnly",
        shape: Shape::Bool,
    },
    Field {
        name: "allowManagedPermissionRulesOnly",
        shape: Shape::Bool,
    },
    Field {
        name: "allowManagedMcpServersOnly",
        shape: Shape::Bool,
    },
    // Auto memory (T47), Claude Code's key: on unless a file turns it off; a project file can
    // only turn it off.
    Field {
        name: "autoMemoryEnabled",
        shape: Shape::Bool,
    },
    // The MCP pool (T36): disconnect a server after this many seconds without a call from any
    // session; defer MCP tools behind `ToolSearch` when a session has more than this many.
    Field {
        name: "mcp",
        shape: Shape::Object(&[
            Field {
                name: "idleTimeoutSeconds",
                shape: Shape::Number,
            },
            Field {
                name: "deferThreshold",
                shape: Shape::Number,
            },
        ]),
    },
    // Automatic compaction (T27, ADR-0043), same names and meaning as Claude Code's keys:
    // `false` turns it off (`/compact` still works); the window caps the context the
    // threshold is computed from (Core clamps it to 100,000–1,000,000 tokens).
    Field {
        name: "autoCompactEnabled",
        shape: Shape::Bool,
    },
    Field {
        name: "autoCompactWindow",
        shape: Shape::Number,
    },
    // File checkpoints (T28, ADR-0044), Claude Code's key: `false` stores no snapshots, so
    // later turns offer no code rewind and the Changes panel lists nothing new.
    Field {
        name: "fileCheckpointingEnabled",
        shape: Shape::Bool,
    },
    // Output style (T37, ADR-0054), Claude Code's key: the name of a built-in or custom
    // style; a name no style has means `Default`.
    Field {
        name: "outputStyle",
        shape: Shape::String,
    },
    // Claude Code's key (T37): skill name → `on`, `name-only`, `user-invocable-only`, `off`.
    Field {
        name: "skillOverrides",
        shape: Shape::MapOf(&Shape::String),
    },
    // `AskUserQuestion`'s form (T26): after this many seconds the questions' default options
    // stand, or the model hears that the user did not answer. Absent: no timeout.
    Field {
        name: "askUserQuestion",
        shape: Shape::Object(&[Field {
            name: "timeoutSeconds",
            shape: Shape::Number,
        }]),
    },
    // Read by Core from the user's file only (`<data>/settings.json`): which executable runs
    // commands is not a project's choice (T17).
    Field {
        name: "shell",
        shape: Shape::Object(&[Field {
            name: "gitBashPath",
            shape: Shape::String,
        }]),
    },
    // The desktop client's preferences (T18), read and written in the user's file only
    // (`piarc_core::client_settings`); a project file setting them has no effect.
    Field {
        name: "language",
        shape: Shape::OneOf(&["system", "en", "zh-CN"]),
    },
    // Local image settings and the native folder capability are read only from the user layer.
    Field {
        name: "markdownImages",
        shape: Shape::Object(&[
            Field {
                name: "mode",
                shape: Shape::OneOf(&[
                    "reference",
                    "document",
                    "assets",
                    "named",
                    "relative",
                    "selected",
                ]),
            },
            Field {
                name: "folder",
                shape: Shape::String,
            },
            Field {
                name: "link",
                shape: Shape::OneOf(&["relativeDot", "relative", "absolute"]),
            },
            Field {
                name: "directory",
                shape: Shape::Object(&[
                    Field {
                        name: "path",
                        shape: Shape::String,
                    },
                    Field {
                        name: "identity",
                        shape: Shape::String,
                    },
                ]),
            },
        ]),
    },
    Field {
        name: "appearance",
        shape: Shape::Object(&[
            Field {
                name: "theme",
                shape: Shape::OneOf(&["system", "light", "dark"]),
            },
            Field {
                name: "contrast",
                shape: Shape::OneOf(&["system", "standard", "high"]),
            },
            Field {
                name: "density",
                shape: Shape::OneOf(&["comfortable", "compact"]),
            },
            Field {
                name: "reduceMotion",
                shape: Shape::OneOf(&["system", "on", "off"]),
            },
        ]),
    },
    // Command id → key in `Mod` notation; an empty string unbinds the command.
    Field {
        name: "keybindings",
        shape: Shape::MapOf(&STRINGS),
    },
    Field {
        name: "notifications",
        shape: Shape::Object(&[Field {
            name: "enabled",
            shape: Shape::Bool,
        }]),
    },
    // The Git panel (ADR-0085), read from the user's file and managed settings only: a project
    // must not unprotect branches or turn on force pushes (`crate::settings` removes it there).
    Field {
        name: "git",
        shape: Shape::Object(&[
            Field {
                name: "branchPrefix",
                shape: Shape::String,
            },
            Field {
                name: "protectedBranches",
                shape: Shape::ListOf(&STRINGS),
            },
            Field {
                name: "pullMode",
                shape: Shape::OneOf(&["config", "merge", "rebase", "ffOnly"]),
            },
            Field {
                name: "alwaysForcePush",
                shape: Shape::Bool,
            },
            Field {
                name: "commitInstructions",
                shape: Shape::String,
            },
        ]),
    },
]);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_pointers_and_unknown_keys() {
        let value = json!({
            "permissions": { "allow": ["Read", 3], "defaultMode": "yolo", "extra/key~": 1 },
            "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "timeout": "60" }] }] },
            "model": 5,
            "theme": "dark"
        });
        let findings = validate(&value, &PIARC_SETTINGS);
        let summary: Vec<(String, Severity)> = findings
            .iter()
            .map(|f| (f.pointer.clone(), f.severity))
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "/hooks/PreToolUse/0/hooks/0/timeout".to_owned(),
                    Severity::Error
                ),
                ("/model".to_owned(), Severity::Error),
                ("/permissions/allow/1".to_owned(), Severity::Error),
                ("/permissions/defaultMode".to_owned(), Severity::Error),
                ("/permissions/extra~1key~0".to_owned(), Severity::Warning),
                ("/theme".to_owned(), Severity::Warning),
            ]
        );
        assert_eq!(findings[1].message, "expected a string, found a number");
        assert!(
            validate(&json!([]), &PIARC_SETTINGS)[0]
                .message
                .contains("expected an object")
        );
    }
}
