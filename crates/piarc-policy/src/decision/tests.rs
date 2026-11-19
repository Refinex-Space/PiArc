use super::*;
use crate::rules::Behavior;
use PermissionMode::{AcceptEdits, BypassPermissions, Default, Plan};

const MODES: [PermissionMode; 4] = [Default, AcceptEdits, Plan, BypassPermissions];

fn hit(behavior: Behavior) -> Hit {
    Hit {
        rule: "Bash(x *)".into(),
        source: "user".into(),
        behavior,
    }
}

fn input(mode: PermissionMode) -> Input {
    Input {
        mode,
        ..Input::default()
    }
}

#[test]
fn deny_then_ask_then_allow_and_allow_never_beats_deny() {
    for mode in MODES {
        let all = Input {
            deny: Some(hit(Behavior::Deny)),
            ask: Some(MustAsk {
                step: "askRule",
                hit: Some(hit(Behavior::Ask)),
            }),
            allow: vec![hit(Behavior::Allow)],
            allowed: true,
            ..input(mode)
        };
        assert_eq!(decide(&all).step, "denyRule", "{mode:?}");
        let ask_allow = Input {
            deny: None,
            ..all.clone()
        };
        assert_eq!(decide(&ask_allow).outcome, Outcome::Ask, "{mode:?}");
        let allow = Input {
            ask: None,
            ..ask_allow
        };
        let r = decide(&allow);
        let expected = match mode {
            BypassPermissions => "bypassPermissions",
            _ => "allowRule",
        };
        assert_eq!(r.step, expected, "{mode:?}");
    }
}

#[test]
fn mandatory_asks_hold_in_every_mode() {
    for step in [
        "criticalPath",
        "unresolved",
        "requiresUserInteraction",
        "askRule",
    ] {
        for mode in MODES {
            let i = Input {
                ask: Some(MustAsk { step, hit: None }),
                allow: vec![hit(Behavior::Allow)],
                allowed: true,
                read_only: true,
                hook: HookVerdict::Allow,
                ..input(mode)
            };
            let r = decide(&i);
            assert_eq!((r.outcome, r.step), (Outcome::Ask, step), "{mode:?}");
        }
    }
}

#[test]
fn plan_refuses_writes_and_bypass_allows_the_rest() {
    let write = Input {
        write: true,
        allow: vec![hit(Behavior::Allow)],
        allowed: true,
        ..input(Plan)
    };
    assert_eq!(decide(&write).step, "planMode");
    assert_eq!(
        decide(&Input {
            write: false,
            ..write.clone()
        })
        .step,
        "allowRule"
    );
    assert_eq!(
        decide(&Input {
            read_only: true,
            ..input(Plan)
        })
        .step,
        "readOnly"
    );
    for extra in [
        Input {
            protected: true,
            ..input(BypassPermissions)
        },
        Input {
            outside: true,
            write: true,
            ..input(BypassPermissions)
        },
    ] {
        assert_eq!(decide(&extra).step, "bypassPermissions");
    }
    assert_eq!(
        decide(&Input {
            protected: true,
            allowed: true,
            allow: vec![hit(Behavior::Allow)],
            ..input(AcceptEdits)
        })
        .step,
        "protectedPath"
    );
}

#[test]
fn mode_defaults() {
    assert_eq!(
        decide(&Input {
            read_only: true,
            ..input(Default)
        })
        .step,
        "readOnly"
    );
    assert_eq!(
        decide(&Input {
            accept_edit: true,
            write: true,
            ..input(Default)
        })
        .step,
        "ask"
    );
    assert_eq!(
        decide(&Input {
            accept_edit: true,
            write: true,
            ..input(AcceptEdits)
        })
        .step,
        "acceptEdits"
    );
    assert_eq!(
        decide(&Input {
            outside: true,
            read_only: true,
            ..input(Default)
        })
        .step,
        "outsideWorkspace"
    );
    assert_eq!(
        decide(&Input {
            outside: true,
            allowed: true,
            allow: vec![hit(Behavior::Allow)],
            ..input(Default)
        })
        .step,
        "allowRule"
    );
    // A changed PATH or IFS: nothing runs on its own.
    let tainted = Input {
        tainted: true,
        read_only: true,
        allowed: true,
        allow: vec![hit(Behavior::Allow)],
        accept_edit: true,
        ..input(AcceptEdits)
    };
    assert_eq!(decide(&tainted).step, "ask");
    assert_eq!(
        decide(&Input {
            mode: BypassPermissions,
            ..tainted
        })
        .step,
        "bypassPermissions"
    );
}

/// T25 fills the slots; a double shows the semantics: allow continues through the rest.
#[test]
fn hook_slots_cannot_skip_deny_ask_or_plan() {
    let allow = HookVerdict::Allow;
    for mode in MODES {
        let denied = Input {
            hook: allow.clone(),
            deny: Some(hit(Behavior::Deny)),
            ..input(mode)
        };
        assert_eq!(decide(&denied).step, "denyRule");
        let asked = Input {
            hook: allow.clone(),
            ask: Some(MustAsk {
                step: "askRule",
                hit: None,
            }),
            ..input(mode)
        };
        assert_eq!(decide(&asked).step, "askRule");
    }
    let plan = Input {
        hook: allow.clone(),
        write: true,
        ..input(Plan)
    };
    assert_eq!(decide(&plan).step, "planMode");
    let plain = Input {
        hook: allow.clone(),
        write: true,
        ..input(Default)
    };
    assert_eq!(decide(&plain).step, "hookAllow");
    let protected = Input {
        hook: allow,
        protected: true,
        ..input(Default)
    };
    assert_eq!(decide(&protected).step, "protectedPath");
    let refused = decide(&Input {
        hook: HookVerdict::Deny("no".into()),
        read_only: true,
        ..input(BypassPermissions)
    });
    assert_eq!(
        (refused.step, refused.reason.as_deref()),
        ("hookDeny", Some("no"))
    );
    assert_eq!(
        decide(&Input {
            hook: HookVerdict::Ask,
            read_only: true,
            ..input(Default)
        })
        .step,
        "hookAsk"
    );
    let enterprise = Input {
        enterprise: Some(hit(Behavior::Deny)),
        hook: HookVerdict::Allow,
        ..input(BypassPermissions)
    };
    assert_eq!(decide(&enterprise).step, "enterpriseDeny");
}

#[test]
fn permission_request_slot() {
    let ask = decide(&Input {
        write: true,
        ..input(Default)
    });
    assert_eq!(
        after_permission_request(ask.clone(), &HookVerdict::Allow).outcome,
        Outcome::Allow
    );
    assert_eq!(
        after_permission_request(ask.clone(), &HookVerdict::Deny("x".into())).outcome,
        Outcome::Deny
    );
    assert_eq!(
        after_permission_request(ask, &HookVerdict::None).outcome,
        Outcome::Ask
    );
    for step in ["criticalPath", "requiresUserInteraction"] {
        let r = decide(&Input {
            ask: Some(MustAsk { step, hit: None }),
            ..input(Default)
        });
        assert_eq!(
            after_permission_request(r, &HookVerdict::Allow).outcome,
            Outcome::Ask
        );
    }
    let allowed = decide(&Input {
        read_only: true,
        ..input(Default)
    });
    assert_eq!(
        after_permission_request(allowed, &HookVerdict::Deny("x".into())).outcome,
        Outcome::Allow
    );
}

#[test]
fn starting_mode_order() {
    assert_eq!(
        starting_mode(Some(Default), Some(Plan), Some("acceptEdits"), false),
        Default
    );
    assert_eq!(
        starting_mode(None, Some(Plan), Some("acceptEdits"), false),
        Plan
    );
    assert_eq!(
        starting_mode(None, None, Some("acceptEdits"), false),
        AcceptEdits
    );
    assert_eq!(starting_mode(None, None, Some("plan"), false), Plan);
    for v in [
        None,
        Some("auto"),
        Some("dontAsk"),
        Some("bypassPermissions"),
    ] {
        assert_eq!(starting_mode(None, None, v, false), Default);
    }
    assert_eq!(
        starting_mode(None, Some(BypassPermissions), None, false),
        Default
    );
    assert_eq!(
        starting_mode(None, Some(BypassPermissions), None, true),
        BypassPermissions
    );
    assert_eq!(
        starting_mode(Some(BypassPermissions), None, Some("plan"), false),
        Plan
    );
    assert_eq!(
        starting_mode(None, None, Some("bypassPermissions"), true),
        BypassPermissions
    );
}
