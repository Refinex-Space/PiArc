use super::*;
use crate::file_diff;

/// Reverts the hunks of `base → current` chosen by `pick` (indices).
fn revert(base: &str, current: &str, pick: &[usize]) -> Result<String, RevertError> {
    let diff = file_diff("f", Some(base), current);
    let hunks: Vec<&DiffHunk> = pick.iter().map(|i| &diff.hunks[*i]).collect();
    revert_hunks(current, &hunks)
}

fn numbered(n: usize, ending: &str) -> String {
    (1..=n).map(|i| format!("line {i}{ending}")).collect()
}

#[test]
fn reverting_every_hunk_gives_the_base_back_byte_for_byte() {
    for ending in ["\n", "\r\n"] {
        let base = numbered(30, ending);
        let current = base
            .replace(&format!("line 2{ending}"), &format!("line two{ending}"))
            .replace(&format!("line 15{ending}"), "")
            .replace(
                &format!("line 27{ending}"),
                &format!("line 27{ending}inserted 中文{ending}"),
            );
        let diff = file_diff("f", Some(&base), &current);
        assert_eq!(diff.hunks.len(), 3);
        assert_eq!(revert(&base, &current, &[0, 1, 2]).expect("all"), base);
        assert_eq!(
            revert(&base, &current, &[2, 0, 1]).expect("any order"),
            base
        );
    }
}

#[test]
fn one_hunk_at_a_time_keeps_the_others() {
    let base = numbered(30, "\r\n");
    let current = base
        .replace("line 3\r\n", "line three\r\nextra\r\n")
        .replace("line 20\r\n", "line twenty\r\n");
    let second_only = revert(&base, &current, &[1]).expect("second");
    assert_eq!(
        second_only,
        base.replace("line 3\r\n", "line three\r\nextra\r\n")
    );
    // The first hunk added a line, the second's numbers are still right after it is reverted.
    let first_only = revert(&base, &current, &[0]).expect("first");
    assert_eq!(first_only, base.replace("line 20\r\n", "line twenty\r\n"));
    // Then the remaining hunk of the refreshed diff.
    assert_eq!(revert(&base, &first_only, &[0]).expect("then"), base);
}

#[test]
fn adjacent_hunks_are_applied_bottom_up() {
    let base = numbered(14, "\n");
    // Seven unchanged lines between the changes: two hunks whose contexts nearly touch.
    let current = base
        .replace("line 2\n", "")
        .replace("line 10\n", "line ten\nline ten b\n");
    let diff = file_diff("f", Some(&base), &current);
    assert_eq!(diff.hunks.len(), 2);
    assert_eq!(revert(&base, &current, &[0, 1]).expect("both"), base);
}

#[test]
fn files_without_a_final_line_break_round_trip() {
    let cases = [
        ("a\nb", "a\nb\nc\n"),
        ("a\nb\n", "a\nb"),
        ("a\nb", "a\nB"),
        ("x\r\ny", "x\r\nY\r\nz"),
    ];
    for (base, current) in cases {
        let diff = file_diff("f", Some(base), current);
        let all: Vec<usize> = (0..diff.hunks.len()).collect();
        assert_eq!(
            revert(base, current, &all).expect("revert"),
            base,
            "{base:?} → {current:?}"
        );
    }
}

#[test]
fn a_created_file_reverts_to_empty_and_a_cleared_one_to_its_lines() {
    let diff = file_diff("f", None, "one\ntwo\n");
    assert_eq!(
        revert_hunks("one\ntwo\n", &[&diff.hunks[0]]).expect("revert"),
        ""
    );
    assert_eq!(
        revert("a\r\nb\r\n", "", &[0]).expect("revert"),
        "a\nb\n",
        "no break left: \\n"
    );
}

#[test]
fn a_hunk_that_no_longer_matches_changes_nothing() {
    let base = numbered(10, "\n");
    let shown = base.replace("line 5\n", "line five\n");
    let diff = file_diff("f", Some(&base), &shown);
    let now = shown.replace("line five\n", "line FIVE\n");
    assert_eq!(
        revert_hunks(&now, &[&diff.hunks[0]]),
        Err(RevertError::Mismatch { line: 2 })
    );
    let shorter = "line 1\n";
    assert!(revert_hunks(shorter, &[&diff.hunks[0]]).is_err());
    assert_eq!(
        revert_hunks(&shown, &[&diff.hunks[0], &diff.hunks[0]]),
        Err(RevertError::Overlap)
    );
}
