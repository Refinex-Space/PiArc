//! `mcp_tool` handlers' input (T41): `${a.b.c}` placeholders in the strings of `input` take the
//! value at that path of the hook input (`${tool_input.file_path}`). A string that is exactly
//! one placeholder takes the value itself (a number stays a number); inside other text strings
//! are inserted as they are and other values as JSON. A path that names nothing gives the empty
//! string.

use serde_json::Value;

/// `template` with its placeholders filled from `input`.
#[must_use]
pub fn fill(template: &Value, input: &Value) -> Value {
    match template {
        Value::String(text) => fill_text(text, input),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, input)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), fill(v, input)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn lookup<'a>(input: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(input, |value, key| match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

fn fill_text(text: &str, input: &Value) -> Value {
    let trimmed = text.trim();
    if let Some(path) = trimmed
        .strip_prefix("${")
        .and_then(|r| r.strip_suffix('}'))
        .filter(|p| !p.contains("${") && !p.contains('}'))
    {
        return lookup(input, path)
            .cloned()
            .unwrap_or(Value::String(String::new()));
    }
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        match lookup(input, &after[..end]) {
            Some(Value::String(s)) => out.push_str(s),
            Some(other) => out.push_str(&other.to_string()),
            None => {}
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Value::String(out)
}

/// The text of an MCP `CallToolResult`'s content (text blocks, joined by newlines).
#[must_use]
pub fn text_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn placeholders_take_values_from_the_input() {
        let input = json!({"tool_input": {"file_path": "/w/a.rs", "limit": 5}, "tags": ["x"]});
        let template = json!({
            "path": "${tool_input.file_path}",
            "limit": "${tool_input.limit}",
            "note": "read ${tool_input.file_path} (${tool_input.limit}) ${missing}",
            "first": ["${tags.0}"],
            "fixed": true
        });
        assert_eq!(
            fill(&template, &input),
            json!({
                "path": "/w/a.rs",
                "limit": 5,
                "note": "read /w/a.rs (5) ",
                "first": ["x"],
                "fixed": true
            })
        );
        assert_eq!(fill(&json!("${nope}"), &input), json!(""));
        assert_eq!(fill(&json!("a ${b"), &input), json!("a ${b"));
    }

    #[test]
    fn text_blocks_are_joined() {
        let content = json!([{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]);
        assert_eq!(text_of(&content), "a\nb");
    }
}
