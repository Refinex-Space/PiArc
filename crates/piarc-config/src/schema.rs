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
        shape: Shape::OneOf(&["command", "prompt", "agent", "http"]),
    },
    Field {
        name: "command",
        shape: Shape::String,
    },
    Field {
        name: "prompt",
        shape: Shape::String,
    },
    Field {
        name: "url",
        shape: Shape::String,
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
    Field {
        name: "$schema",
        shape: Shape::String,
    },
    Field {
        name: "model",
        shape: Shape::String,
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
        ]),
    },
    Field {
        name: "hooks",
        shape: Shape::MapOf(&HOOK_GROUPS),
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
