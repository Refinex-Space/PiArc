use piarc_protocol::policy::PermissionMode::{AcceptEdits, BypassPermissions, Default, Plan};

use super::stricter;

#[test]
fn the_stricter_mode_wins() {
    assert_eq!(stricter(AcceptEdits, Default), Default);
    assert_eq!(stricter(Plan, Default), Plan);
    assert_eq!(stricter(BypassPermissions, AcceptEdits), AcceptEdits);
    assert_eq!(stricter(Default, BypassPermissions), Default);
    assert_eq!(stricter(Plan, Plan), Plan);
}
