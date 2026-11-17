//! Event assertions: field-subset matching and ordered subsequences, with readable output.
//!
//! - A value matches an expected value when objects contain every expected key with a
//!   matching value (other keys are ignored, so ids and timestamps never need writing),
//!   arrays have the same length and match element by element, and scalars are equal.
//! - Expected events form an ordered subsequence per session: each item matches a later
//!   event than the item before it. An `any_order` group matches distinct events in any
//!   order (each member takes the first unused match), all after the previous item; the next
//!   item starts after the group's last match.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::Value;

use super::format::{EventExpect, EventMatcher};

/// One delivered session notification, with the session's label.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservedEvent {
    /// The session's label in the scenario.
    pub session: String,
    /// The notification method.
    pub method: String,
    /// Its params.
    pub params: Value,
}

/// The first place where `actual` does not contain `expected`, as `<path>: <reason>`;
/// `None` when it does.
#[must_use]
pub fn subset_mismatch(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Object(want), Value::Object(have)) => want.iter().find_map(|(key, value)| {
            let field = format!("{path}.{key}");
            match have.get(key) {
                Some(found) => subset_mismatch(value, found, &field),
                None => Some(format!(
                    "{field}: missing (expected {})",
                    compact(value, 80)
                )),
            }
        }),
        (Value::Array(want), Value::Array(have)) => {
            if want.len() != have.len() {
                return Some(format!(
                    "{path}: expected {} elements, got {}: {}",
                    want.len(),
                    have.len(),
                    compact(actual, 160)
                ));
            }
            want.iter()
                .zip(have)
                .enumerate()
                .find_map(|(n, (w, h))| subset_mismatch(w, h, &format!("{path}[{n}]")))
        }
        _ if expected == actual => None,
        _ => Some(format!(
            "{path}: expected {}, got {}",
            compact(expected, 120),
            compact(actual, 120)
        )),
    }
}

/// `actual` contains `expected` (see the module documentation).
#[must_use]
pub fn is_subset(expected: &Value, actual: &Value) -> bool {
    subset_mismatch(expected, actual, "").is_none()
}

/// Whether `event` matches `matcher`; `turns` maps turn labels to turn ids.
#[must_use]
pub fn matches(
    matcher: &EventMatcher,
    session: &str,
    event: &ObservedEvent,
    turns: &BTreeMap<String, String>,
) -> bool {
    event.session == session
        && event.method == matcher.method
        && matcher
            .params
            .as_ref()
            .is_none_or(|params| is_subset(params, &event.params))
        && matcher.turn.as_ref().is_none_or(|label| {
            turns
                .get(label)
                .is_some_and(|id| event.params.get("turnId").and_then(Value::as_str) == Some(id))
        })
}

/// Checks the expected events against the delivered ones. `session_of` resolves a matcher's
/// optional session to its label (the loader already checked that it can).
///
/// # Errors
///
/// A readable report of the first expected item that has no match: the item, the last item
/// that matched, where an out-of-order match was, and the delivered events around the place
/// the match was looked for.
pub fn check_events(
    expected: &[EventExpect],
    events: &[ObservedEvent],
    turns: &BTreeMap<String, String>,
    session_of: impl Fn(Option<&str>) -> String,
) -> Result<(), String> {
    // Per session: the expected items in order, with their index in the file.
    let mut per_session: BTreeMap<String, Vec<(usize, &EventExpect)>> = BTreeMap::new();
    for (n, item) in expected.iter().enumerate() {
        let session = item
            .matchers()
            .first()
            .map(|m| session_of(m.session.as_deref()))
            .unwrap_or_default();
        per_session.entry(session).or_default().push((n, item));
    }
    for (session, items) in per_session {
        let mut position = 0;
        let mut last_matched: Option<(usize, usize)> = None;
        for (n, item) in items {
            let mut used: Vec<usize> = Vec::new();
            for matcher in item.matchers() {
                let found = (position..events.len())
                    .find(|&i| !used.contains(&i) && matches(matcher, &session, &events[i], turns));
                match found {
                    Some(i) => used.push(i),
                    None => {
                        return Err(report(&Unmatched {
                            index: n,
                            matcher,
                            session: &session,
                            position,
                            last_matched,
                            events,
                            turns,
                        }));
                    }
                }
            }
            let end = used.iter().copied().max().unwrap_or(position);
            last_matched = Some((n, end));
            position = end + 1;
        }
    }
    Ok(())
}

struct Unmatched<'a> {
    index: usize,
    matcher: &'a EventMatcher,
    session: &'a str,
    position: usize,
    last_matched: Option<(usize, usize)>,
    events: &'a [ObservedEvent],
    turns: &'a BTreeMap<String, String>,
}

fn report(u: &Unmatched<'_>) -> String {
    let mut out = format!(
        "expect.events[{}] has no match in session `{}`: {}\n",
        u.index,
        u.session,
        describe(u.matcher)
    );
    match u.last_matched {
        Some((n, at)) => {
            let _ = writeln!(
                out,
                "  searched after event #{at} (matched by expect.events[{n}])"
            );
        }
        None => out.push_str("  searched from the first event\n"),
    }
    let earlier = (0..u.position.min(u.events.len()))
        .find(|&i| matches(u.matcher, u.session, &u.events[i], u.turns));
    if let Some(i) = earlier {
        let _ = writeln!(
            out,
            "  an event matching it came earlier, at #{i} (out of order)"
        );
    } else if let Some(closest) = closest(u) {
        let _ = writeln!(out, "  closest event with this method: {closest}");
    }
    let session_events: Vec<usize> = (0..u.events.len())
        .filter(|&i| u.events[i].session == u.session)
        .collect();
    let around = session_events
        .iter()
        .position(|&i| i >= u.position)
        .unwrap_or(session_events.len());
    let from = around.saturating_sub(3);
    let to = (around + 8).min(session_events.len());
    let _ = writeln!(
        out,
        "  delivered events of `{}` near that place ({} in all):",
        u.session,
        session_events.len()
    );
    for &i in &session_events[from..to] {
        let marker = if i >= u.position { ">" } else { " " };
        let event = &u.events[i];
        let _ = writeln!(
            out,
            "   {marker} #{i} {} {}",
            event.method,
            compact(&without_noise(&event.params), 160)
        );
    }
    out
}

/// Why the first event with the matcher's method (at or after the search position) failed.
fn closest(u: &Unmatched<'_>) -> Option<String> {
    let i = (u.position..u.events.len())
        .find(|&i| u.events[i].session == u.session && u.events[i].method == u.matcher.method)?;
    let event = &u.events[i];
    if let Some(params) = &u.matcher.params
        && let Some(why) = subset_mismatch(params, &event.params, "params")
    {
        return Some(format!("#{i}: {why}"));
    }
    u.matcher.turn.as_ref().map(|label| {
        format!(
            "#{i}: params.turnId {} is not turn `{label}` ({})",
            compact(&event.params["turnId"], 60),
            u.turns.get(label).map_or("never started", String::as_str)
        )
    })
}

/// `params` without the fields every notification has (`seq`, `sessionId`, `ts`), for display.
#[must_use]
pub fn without_noise(params: &Value) -> Value {
    let mut params = params.clone();
    if let Some(object) = params.as_object_mut() {
        for key in ["seq", "sessionId", "ts"] {
            object.remove(key);
        }
    }
    params
}

/// A matcher in one line.
#[must_use]
pub fn describe(matcher: &EventMatcher) -> String {
    let mut text = matcher.method.clone();
    if let Some(turn) = &matcher.turn {
        let _ = write!(text, " turn={turn}");
    }
    if let Some(params) = &matcher.params {
        let _ = write!(text, " {}", compact(params, 160));
    }
    text
}

/// Compact JSON, cut to `max` characters.
#[must_use]
pub fn compact(value: &Value, max: usize) -> String {
    let text = value.to_string();
    if text.chars().count() <= max {
        return text;
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(method: &str, params: Value) -> ObservedEvent {
        ObservedEvent {
            session: "main".into(),
            method: method.into(),
            params,
        }
    }

    fn matcher(method: &str, params: Option<Value>) -> EventMatcher {
        EventMatcher {
            session: None,
            method: method.into(),
            params,
            turn: None,
        }
    }

    fn main_session(_: Option<&str>) -> String {
        "main".into()
    }

    #[test]
    fn subsets_ignore_extra_keys_and_compare_arrays_element_wise() {
        let actual =
            json!({ "item": { "id": "x1", "status": "completed", "tags": [1, 2] }, "seq": 4 });
        assert!(is_subset(
            &json!({ "item": { "status": "completed" } }),
            &actual
        ));
        assert!(is_subset(&json!({ "item": { "tags": [1, 2] } }), &actual));
        assert_eq!(
            subset_mismatch(&json!({ "item": { "tags": [1] } }), &actual, "params"),
            Some("params.item.tags: expected 1 elements, got 2: [1,2]".into())
        );
        assert_eq!(
            subset_mismatch(
                &json!({ "item": { "status": "failed" } }),
                &actual,
                "params"
            ),
            Some("params.item.status: expected \"failed\", got \"completed\"".into())
        );
        assert!(subset_mismatch(&json!({ "missing": 1 }), &actual, "p").is_some());
    }

    #[test]
    fn expected_events_form_an_ordered_subsequence_with_any_order_groups() {
        let events = vec![
            event("turn/started", json!({})),
            event("item/completed", json!({ "item": { "itemId": "b" } })),
            event("item/completed", json!({ "item": { "itemId": "a" } })),
            event("turn/completed", json!({ "status": "completed" })),
        ];
        let group = EventExpect::AnyOrder {
            any_order: vec![
                matcher("item/completed", Some(json!({ "item": { "itemId": "a" } }))),
                matcher("item/completed", Some(json!({ "item": { "itemId": "b" } }))),
            ],
        };
        let expected = vec![
            EventExpect::One(matcher("turn/started", None)),
            group,
            EventExpect::One(matcher(
                "turn/completed",
                Some(json!({ "status": "completed" })),
            )),
        ];
        assert_eq!(
            check_events(&expected, &events, &BTreeMap::new(), main_session),
            Ok(())
        );
    }

    #[test]
    fn an_out_of_order_event_is_reported_with_its_position_and_neighbours() {
        let events = vec![
            event("turn/completed", json!({ "status": "completed" })),
            event("turn/started", json!({})),
        ];
        let expected = vec![
            EventExpect::One(matcher("turn/started", None)),
            EventExpect::One(matcher("turn/completed", None)),
        ];
        let report = check_events(&expected, &events, &BTreeMap::new(), main_session)
            .expect_err("out of order");
        assert!(report.contains("expect.events[1] has no match"), "{report}");
        assert!(report.contains("came earlier, at #0"), "{report}");
        assert!(report.contains("#1 turn/started"), "{report}");
    }

    #[test]
    fn a_mismatching_field_is_named() {
        let events = vec![event("turn/completed", json!({ "status": "interrupted" }))];
        let expected = vec![EventExpect::One(matcher(
            "turn/completed",
            Some(json!({ "status": "completed" })),
        ))];
        let report =
            check_events(&expected, &events, &BTreeMap::new(), main_session).expect_err("mismatch");
        assert!(
            report.contains("params.status: expected \"completed\", got \"interrupted\""),
            "{report}"
        );
    }

    #[test]
    fn turn_labels_match_the_turn_id() {
        let events = vec![event("turn/completed", json!({ "turnId": "t-2" }))];
        let mut m = matcher("turn/completed", None);
        m.turn = Some("first".into());
        let turns = BTreeMap::from([("first".to_owned(), "t-1".to_owned())]);
        assert!(
            check_events(
                &[EventExpect::One(m.clone())],
                &events,
                &turns,
                main_session
            )
            .is_err()
        );
        let turns = BTreeMap::from([("first".to_owned(), "t-2".to_owned())]);
        assert!(check_events(&[EventExpect::One(m)], &events, &turns, main_session).is_ok());
    }
}
