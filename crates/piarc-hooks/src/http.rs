//! `http` handlers (Claude Code's semantics, ADR-0055):
//!
//! - `allowedHttpHookUrls`, when set (resolved by piarc-config, ADR-0065), admits only URLs that match
//!   one of its patterns: `*` matches any text, the scheme and host compare without case and a
//!   trailing dot of the host is ignored. Other URLs get no request; that is a non-blocking error.
//! - Header values interpolate `$VAR` and `${VAR}` only for variables the handler's
//!   `allowedEnvVars` lists and, when `httpHookAllowedEnvVars` is set, that list too; any other
//!   reference becomes the empty string.
//! - The response: 2xx with an empty body is success without output; 2xx with a JSON object is
//!   read like a command's stdout JSON; any other body, any other status, a failed connection
//!   and a timeout are non-blocking errors.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::config::Http;
use crate::event::HookEvent;
use crate::output::check_specific;
use crate::ports::{HttpCall, HttpReply};

/// The settings and environment `http` handlers run under.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpRules {
    /// `allowedHttpHookUrls`; `None` when unset (every URL).
    pub allowed_urls: Option<Vec<String>>,
    /// `httpHookAllowedEnvVars`; `None` when unset (the handler's own list decides).
    pub allowed_env_vars: Option<Vec<String>>,
    /// The variables header values may name.
    pub env: HashMap<String, String>,
}

impl HttpRules {
    /// Whether `url` may be posted to.
    #[must_use]
    pub fn url_allowed(&self, url: &str) -> bool {
        self.allowed_urls
            .as_ref()
            .is_none_or(|patterns| patterns.iter().any(|p| glob(&normal(p), &normal(url))))
    }

    /// The request of `handler` with `input` as the body.
    #[must_use]
    pub fn call(&self, handler: &Http, input: &[u8]) -> HttpCall {
        let allowed = |name: &str| {
            handler.allowed_env_vars.iter().any(|v| v == name)
                && self
                    .allowed_env_vars
                    .as_ref()
                    .is_none_or(|list| list.iter().any(|v| v == name))
        };
        let mut headers: Vec<(String, String)> = handler
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("content-type"))
            .map(|(name, value)| (name.clone(), interpolate(value, &allowed, &self.env)))
            .collect();
        headers.push(("Content-Type".into(), "application/json".into()));
        HttpCall {
            url: handler.url.clone(),
            headers,
            body: input.to_vec(),
        }
    }
}

/// The URL with its scheme and host lowercase and the host's trailing dot removed; the rest
/// (path, query) as written.
fn normal(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(split);
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit() || c == '*') =>
        {
            (host, Some(port))
        }
        _ => (authority, None),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}{tail}", scheme.to_ascii_lowercase())
}

/// `*` matches any text (also empty); everything else literally.
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, rest) = parts.split_first().unwrap_or((&"", &[]));
    let Some(mut remaining) = text.strip_prefix(first) else {
        return false;
    };
    let Some((last, middle)) = rest.split_last() else {
        return remaining.is_empty();
    };
    for part in middle {
        match remaining.find(part) {
            Some(at) => remaining = &remaining[at + part.len()..],
            None => return false,
        }
    }
    remaining.ends_with(last)
}

/// `$NAME` and `${NAME}` replaced by `env`'s value when `allowed`, by nothing otherwise.
fn interpolate(
    value: &str,
    allowed: &dyn Fn(&str) -> bool,
    env: &HashMap<String, String>,
) -> String {
    let is_name = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (name, consumed) = if let Some(braced) = after.strip_prefix('{') {
            match braced.find('}') {
                Some(end) if braced[..end].chars().all(is_name) && end > 0 => {
                    (&braced[..end], end + 2)
                }
                _ => ("", 0),
            }
        } else {
            let end = after.find(|c: char| !is_name(c)).unwrap_or(after.len());
            (&after[..end], end)
        };
        if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
            out.push('$');
            rest = after;
            continue;
        }
        if allowed(name)
            && let Some(v) = env.get(name)
        {
            out.push_str(v);
        }
        rest = &after[consumed..];
    }
    out.push_str(rest);
    out
}

/// Reads a response for `event`: the JSON output object, or the non-blocking error.
pub(crate) fn read_reply(
    event: HookEvent,
    reply: &HttpReply,
) -> Result<Map<String, Value>, String> {
    if !(200..300).contains(&reply.status) {
        return Err(format!("the server answered HTTP {}", reply.status));
    }
    let text = String::from_utf8_lossy(&reply.body);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Map::new());
    }
    let Ok(Value::Object(json)) = serde_json::from_str::<Value>(text) else {
        return Err("the response body is not a JSON object".into());
    };
    check_specific(event, &json)?;
    Ok(json)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn rules(urls: Option<&[&str]>, vars: Option<&[&str]>) -> HttpRules {
        let list = |l: &[&str]| l.iter().map(|s| (*s).to_owned()).collect();
        HttpRules {
            allowed_urls: urls.map(list),
            allowed_env_vars: vars.map(list),
            env: HashMap::from([
                ("TOKEN".to_owned(), "t-1".to_owned()),
                ("OTHER".to_owned(), "o-2".to_owned()),
            ]),
        }
    }

    #[test]
    fn unset_allows_every_url_and_patterns_match_with_wildcards() {
        assert!(rules(None, None).url_allowed("https://anything.example/x"));
        let r = rules(
            Some(&["https://hooks.example.com/*", "http://localhost:*"]),
            None,
        );
        assert!(r.url_allowed("https://hooks.example.com/a/b?c=1"));
        assert!(r.url_allowed("HTTPS://Hooks.Example.COM./a"));
        assert!(r.url_allowed("http://localhost:8080/hook"));
        assert!(!r.url_allowed("https://evil.example.com/a"));
        assert!(!r.url_allowed("http://hooks.example.com/a"));
        assert!(!rules(Some(&[]), None).url_allowed("https://hooks.example.com/"));
        assert!(
            rules(Some(&["https://a.example/hook"]), None).url_allowed("https://a.example/hook")
        );
        assert!(
            !rules(Some(&["https://a.example/hook"]), None).url_allowed("https://a.example/hooks")
        );
    }

    #[test]
    fn headers_interpolate_only_listed_variables() {
        let handler = Http {
            url: "https://h.example/".into(),
            headers: BTreeMap::from([
                ("Authorization".to_owned(), "Bearer $TOKEN".to_owned()),
                (
                    "X-Other".to_owned(),
                    "${OTHER}-$UNSET-$$-${bad name}".to_owned(),
                ),
                ("content-type".to_owned(), "text/plain".to_owned()),
            ]),
            allowed_env_vars: vec!["TOKEN".into(), "UNSET".into()],
        };
        let header = |call: &HttpCall, name: &str| {
            call.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
        };
        let call = rules(None, None).call(&handler, b"{}");
        assert_eq!(
            header(&call, "Authorization").as_deref(),
            Some("Bearer t-1")
        );
        assert_eq!(
            header(&call, "X-Other").as_deref(),
            Some("--$$-${bad name}")
        );
        assert_eq!(
            header(&call, "Content-Type").as_deref(),
            Some("application/json")
        );
        assert_eq!(header(&call, "content-type"), None);
        assert_eq!(call.body, b"{}");
        let narrowed = rules(None, Some(&["OTHER"])).call(&handler, b"{}");
        assert_eq!(
            header(&narrowed, "Authorization").as_deref(),
            Some("Bearer ")
        );
    }

    #[test]
    fn responses_follow_the_output_protocol() {
        let reply = |status, body: &str| HttpReply {
            status,
            body: body.as_bytes().to_vec(),
        };
        assert_eq!(read_reply(HookEvent::Stop, &reply(204, "")), Ok(Map::new()));
        let json = read_reply(
            HookEvent::Stop,
            &reply(200, r#" {"decision":"block","reason":"r"} "#),
        );
        assert_eq!(
            json.map(|j| j.get("decision").cloned()),
            Ok(Some("block".into()))
        );
        assert!(read_reply(HookEvent::Stop, &reply(200, "plain text")).is_err());
        assert!(read_reply(HookEvent::Stop, &reply(200, "[1]")).is_err());
        assert_eq!(
            read_reply(HookEvent::Stop, &reply(500, r#"{"decision":"block"}"#)),
            Err("the server answered HTTP 500".into())
        );
        assert!(
            read_reply(
                HookEvent::PreToolUse,
                &reply(200, r#"{"hookSpecificOutput":{"hookEventName":"Stop"}}"#)
            )
            .is_err()
        );
    }
}
