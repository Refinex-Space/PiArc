use std::collections::HashMap;
use std::convert::Infallible;

use super::*;
use crate::store::hash_of;

fn h(text: &str) -> Hash {
    hash_of(text.as_bytes())
}

fn record(
    id: i64,
    checkpoint: i64,
    path: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> FileRecord {
    FileRecord {
        id,
        checkpoint,
        path: path.to_owned(),
        before: before.map(h),
        after: after.map(h),
        operation: if before.is_none() {
            Operation::Create
        } else {
            Operation::Modify
        },
        restore_id: None,
    }
}

fn disk(files: &[(&str, &str)]) -> impl FnMut(&str) -> Result<Option<Hash>, Infallible> {
    let map: HashMap<String, Hash> = files.iter().map(|(p, c)| ((*p).to_owned(), h(c))).collect();
    move |path| Ok(map.get(path).copied())
}

fn same(path: &str) -> String {
    path.to_owned()
}

fn steps(plan: &[PlannedFile]) -> Vec<(&str, Step)> {
    plan.iter().map(|f| (f.path.as_str(), f.step)).collect()
}

#[test]
fn a_created_file_is_deleted_and_a_modified_one_gets_its_old_content() {
    let records = [
        record(1, 1, "new.txt", None, Some("A")),
        record(2, 1, "src/lib 中文.rs", Some("B0"), Some("B1")),
    ];
    let plan = plan_restore(
        &records,
        1,
        same,
        disk(&[("new.txt", "A"), ("src/lib 中文.rs", "B1")]),
    )
    .expect("plan");
    assert_eq!(
        steps(&plan),
        [("new.txt", Step::Delete), ("src/lib 中文.rs", Step::Write)]
    );
    assert_eq!(plan[0].target, None);
    assert_eq!(plan[1].target, Some(h("B0")));
}

#[test]
fn the_target_is_the_content_when_the_chosen_turn_started() {
    let records = [
        record(1, 1, "b", Some("B0"), Some("B1")),
        record(2, 2, "b", Some("B1"), Some("B2")),
        record(3, 2, "b", Some("B2"), Some("B3")),
        record(4, 3, "c", Some("C0"), Some("C1")),
    ];
    let current = [("b", "B3"), ("c", "C1")];
    let to_2 = plan_restore(&records, 2, same, disk(&current)).expect("plan");
    assert_eq!(steps(&to_2), [("b", Step::Write), ("c", Step::Write)]);
    assert_eq!(to_2[0].target, Some(h("B1")));
    assert_eq!(to_2[0].expected, Some(h("B3")));
    let to_1 = plan_restore(&records, 1, same, disk(&current)).expect("plan");
    assert_eq!(to_1[0].target, Some(h("B0")));
    let to_3 = plan_restore(&records, 3, same, disk(&current)).expect("plan");
    assert_eq!(
        steps(&to_3),
        [("c", Step::Write)],
        "b was not written since"
    );
}

#[test]
fn a_file_changed_outside_the_session_is_a_conflict() {
    let records = [
        record(1, 1, "b", Some("B0"), Some("B1")),
        record(2, 1, "gone", None, Some("G")),
        record(3, 1, "back", Some("K0"), Some("K1")),
    ];
    let plan = plan_restore(
        &records,
        1,
        same,
        disk(&[("b", "changed by bash"), ("back", "K0")]),
    )
    .expect("plan");
    assert_eq!(
        steps(&plan),
        [
            ("b", Step::Conflict),
            ("gone", Step::Unchanged),
            ("back", Step::Unchanged)
        ],
        "a deleted created file and an already restored file need nothing"
    );
    let deleted = [record(1, 1, "d", Some("D0"), Some("D1"))];
    let plan = plan_restore(&deleted, 1, same, disk(&[])).expect("plan");
    assert_eq!(
        steps(&plan),
        [("d", Step::Conflict)],
        "deleted by someone else"
    );
    assert_eq!(plan[0].current, None);
}

#[test]
fn a_previous_rewind_counts_as_the_sessions_last_write() {
    let mut records = vec![
        record(1, 1, "b", Some("B0"), Some("B1")),
        record(2, 2, "b", Some("B1"), Some("B2")),
    ];
    // Rewind to turn 2: b goes back to B1, recorded on the latest checkpoint.
    records.push(FileRecord {
        operation: Operation::Restore,
        restore_id: Some("r1".into()),
        ..record(3, 2, "b", Some("B2"), Some("B1"))
    });
    let plan = plan_restore(&records, 1, same, disk(&[("b", "B1")])).expect("plan");
    assert_eq!(steps(&plan), [("b", Step::Write)], "no false conflict");
    assert_eq!(plan[0].target, Some(h("B0")));
}

#[test]
fn paths_are_grouped_by_key_and_named_by_their_latest_spelling() {
    let records = [
        record(1, 1, "Src/A.txt", Some("0"), Some("1")),
        record(2, 1, "src/a.txt", Some("1"), Some("2")),
    ];
    let lower = |p: &str| p.to_lowercase();
    let plan = plan_restore(&records, 1, lower, disk(&[("src/a.txt", "2")])).expect("plan");
    assert_eq!(steps(&plan), [("src/a.txt", Step::Write)]);
    assert_eq!(plan[0].target, Some(h("0")));
    let bases = baselines(&records, |p: &str| p.to_lowercase());
    assert_eq!(
        bases,
        [Baseline {
            path: "src/a.txt".into(),
            before: Some(h("0"))
        }]
    );
}

#[test]
fn undo_puts_back_what_the_rewind_replaced_unless_it_changed_again() {
    let restore = |id, path: &str, before: &str, after: Option<&str>| FileRecord {
        operation: Operation::Restore,
        restore_id: Some("r1".into()),
        ..record(id, 2, path, Some(before), after)
    };
    let records = [
        record(1, 1, "a", Some("A0"), Some("A1")),
        restore(2, "a", "A1", Some("A0")),
        restore(3, "created", "N", None),
        restore(4, "edited", "E1", Some("E0")),
        FileRecord {
            restore_id: Some("other".into()),
            ..restore(5, "x", "X1", Some("X0"))
        },
    ];
    let plan = plan_undo(
        &records,
        "r1",
        same,
        disk(&[("a", "A0"), ("edited", "edited again")]),
    )
    .expect("plan");
    assert_eq!(
        steps(&plan),
        [
            ("a", Step::Write),
            ("created", Step::Write),
            ("edited", Step::Conflict)
        ]
    );
    assert_eq!(plan[1].target, Some(h("N")), "the deleted file comes back");
}

#[test]
fn baselines_follow_first_writes() {
    let records = [
        record(2, 1, "b", Some("B0"), Some("B1")),
        record(1, 1, "a", None, Some("A")),
        record(3, 2, "b", Some("B1"), Some("B2")),
    ];
    assert_eq!(
        baselines(&records, same),
        [
            Baseline {
                path: "a".into(),
                before: None
            },
            Baseline {
                path: "b".into(),
                before: Some(h("B0"))
            }
        ]
    );
}

#[test]
fn operations_round_trip() {
    for op in [
        Operation::Create,
        Operation::Modify,
        Operation::Restore,
        Operation::Undo,
        Operation::Discard,
    ] {
        assert_eq!(Operation::parse(op.as_str()), Some(op));
    }
    assert_eq!(Operation::parse("delete"), None);
}
