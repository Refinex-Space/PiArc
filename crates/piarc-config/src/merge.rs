//! Merging layers and finding what changed.
//!
//! Merge rules (ADR-0005): a higher layer's scalar replaces a lower one's; objects merge key
//! by key, recursively; lists are concatenated from the lowest layer up with duplicates
//! dropped (first occurrence kept). A value of a different type replaces the lower one.
//! Deny-first evaluation of permission lists is `piarc-policy`'s (T20, T23).

use serde_json::{Map, Value};

use crate::schema::push_token;

/// Merges `upper` onto `lower` in place.
pub fn merge_into(lower: &mut Value, upper: &Value) {
    match (lower, upper) {
        (Value::Object(base), Value::Object(top)) => {
            for (key, value) in top {
                match base.get_mut(key) {
                    Some(existing) => merge_into(existing, value),
                    None => {
                        base.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(base), Value::Array(top)) => {
            for item in top {
                if !base.contains(item) {
                    base.push(item.clone());
                }
            }
        }
        (lower, upper) => *lower = upper.clone(),
    }
}

/// Merges `layers` from lowest to highest into one object.
#[must_use]
pub fn merge_all<'a>(layers: impl IntoIterator<Item = &'a Value>) -> Value {
    let mut merged = Value::Object(Map::new());
    for layer in layers {
        merge_into(&mut merged, layer);
    }
    merged
}

/// JSON Pointers of the values that differ between `before` and `after`: objects are compared
/// key by key, everything else (lists included) as a whole. Sorted.
#[must_use]
pub fn changed_keys(before: &Value, after: &Value) -> Vec<String> {
    let mut out = Vec::new();
    diff(before, after, &mut String::new(), &mut out);
    out.sort();
    out
}

fn diff(before: &Value, after: &Value, pointer: &mut String, out: &mut Vec<String>) {
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, left) in a {
                let len = pointer.len();
                push_token(pointer, key);
                match b.get(key) {
                    Some(right) => diff(left, right, pointer, out),
                    None => out.push(pointer.clone()),
                }
                pointer.truncate(len);
            }
            for key in b.keys().filter(|k| !a.contains_key(*k)) {
                let len = pointer.len();
                push_token(pointer, key);
                out.push(pointer.clone());
                pointer.truncate(len);
            }
        }
        (a, b) if a != b => out.push(pointer.clone()),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scalars_override_objects_merge_lists_union() {
        let merged = merge_all([
            &json!({ "model": "a", "permissions": { "allow": ["Read", "Bash(ls)"], "defaultMode": "default" }, "x": { "y": 1 } }),
            &json!({ "model": "b", "permissions": { "allow": ["Bash(ls)", "Edit"], "deny": ["Bash(rm *)"] } }),
            &json!({ "x": 2, "permissions": { "defaultMode": "plan" } }),
        ]);
        assert_eq!(
            merged,
            json!({
                "model": "b",
                "permissions": { "allow": ["Read", "Bash(ls)", "Edit"], "deny": ["Bash(rm *)"], "defaultMode": "plan" },
                "x": 2
            })
        );
    }

    #[test]
    fn changed_keys_are_pointers_to_differing_leaves() {
        let before =
            json!({ "model": "a", "permissions": { "allow": ["Read"], "deny": [] }, "gone": 1 });
        let after = json!({ "model": "a", "permissions": { "allow": ["Read", "Edit"], "deny": [] }, "new/key": true });
        assert_eq!(
            changed_keys(&before, &after),
            ["/gone", "/new~1key", "/permissions/allow"]
        );
        assert!(changed_keys(&after, &after).is_empty());
    }
}
