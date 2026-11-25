//! The HTTP proxy of the Agent Hosts (ADR-0082): model providers and sign-in reach the network
//! through it when the user sets one, or when the system has one and the user left the choice to
//! PiArc (the default).
//!
//! The user's `settings.json` holds `proxy: { mode: "auto" | "manual", url? }`. In `auto` mode
//! the proxy is the system's, which the main process resolves through Electron (system settings
//! and PAC) and hands over with [`Proxy::set_system`]; in `manual` mode it is `url`. Core puts
//! the effective one into each Agent Host's environment when it starts the process
//! (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` for the loopback and `NODE_USE_ENV_PROXY=1`, which
//! makes Node's `fetch` honour them; pi-ai's WebSocket transport reads the same variables). A
//! change restarts the workspaces' Agent Hosts once they are idle (`sessions::workspace`).
//!
//! Proxy addresses carry no credentials: a user name or password would put a secret into a
//! settings file and a process environment (architecture section 10), so such an address is
//! refused.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

/// Hosts the Agent Host reaches directly whatever the proxy: the loopback (a local model server,
/// the test providers).
pub const NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// Why a proxy address is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyUrlError {
    /// Not `http://` or `https://`.
    Scheme,
    /// No host, or one with characters a host name or address cannot have.
    Host,
    /// A port outside 1–65535.
    Port,
    /// A user name or password: secrets do not go into settings files.
    Credentials,
    /// A path, query or fragment: a proxy is a host and a port.
    Path,
}

impl ProxyUrlError {
    /// The reason in English, for errors and logs.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Scheme => "the proxy address must start with http:// or https://",
            Self::Host => "the proxy address needs a host name or IP address",
            Self::Port => "the proxy port must be between 1 and 65535",
            Self::Credentials => "the proxy address cannot contain a user name or password",
            Self::Path => "the proxy address is a host and a port, without a path",
        }
    }
}

/// `text` as a proxy address: `http(s)://host[:port]`, lower-case scheme and host, no trailing
/// slash.
///
/// # Errors
///
/// [`ProxyUrlError`] for anything else.
pub fn check_url(text: &str) -> Result<String, ProxyUrlError> {
    let text = text.trim();
    let lower = text.to_ascii_lowercase();
    let (scheme, rest) = if lower.starts_with("http://") {
        ("http", &text["http://".len()..])
    } else if lower.starts_with("https://") {
        ("https", &text["https://".len()..])
    } else {
        return Err(ProxyUrlError::Scheme);
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if !(tail.is_empty() || tail == "/") {
        return Err(ProxyUrlError::Path);
    }
    if authority.contains('@') {
        return Err(ProxyUrlError::Credentials);
    }
    let (host, port) = split_host_port(authority)?;
    let host = host.to_ascii_lowercase();
    Ok(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

fn split_host_port(authority: &str) -> Result<(&str, Option<u16>), ProxyUrlError> {
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        // An IPv6 address in brackets, maybe followed by a port.
        let close = inner.find(']').ok_or(ProxyUrlError::Host)?;
        let address = &inner[..close];
        if address.is_empty()
            || !address
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return Err(ProxyUrlError::Host);
        }
        let after = &inner[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port),
            None if after.is_empty() => None,
            None => return Err(ProxyUrlError::Host),
        };
        (&authority[..close + 2], port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if !host.starts_with('[')
        && (host.is_empty()
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
    {
        return Err(ProxyUrlError::Host);
    }
    let port = match port {
        None => None,
        Some(text) => match text.parse::<u16>() {
            Ok(port) if port > 0 && !text.starts_with('+') => Some(port),
            _ => return Err(ProxyUrlError::Port),
        },
    };
    Ok((host, port))
}

/// The user's choice in `settings.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxySetting {
    /// The system's proxy (the default, and what an unreadable choice falls back to).
    Auto,
    /// This address.
    Manual(String),
}

impl ProxySetting {
    /// The choice in the user's settings object (`settings.json` as read).
    #[must_use]
    pub fn of(settings: &Value) -> Self {
        let Some(proxy) = settings.get("proxy") else {
            return Self::Auto;
        };
        if proxy.get("mode").and_then(Value::as_str) != Some("manual") {
            return Self::Auto;
        }
        match proxy.get("url").and_then(Value::as_str).map(check_url) {
            Some(Ok(url)) => Self::Manual(url),
            // A manual choice without a usable address goes nowhere rather than somewhere else.
            _ => Self::Manual(String::new()),
        }
    }
}

/// Checks the `proxy` object a client writes (the whole object or one of its members).
///
/// # Errors
///
/// The reason, when the value is not a proxy choice PiArc accepts.
pub fn check_setting(pointer: &str, value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let check_mode = |mode: &Value| match mode.as_str() {
        Some("auto" | "manual") => Ok(()),
        _ => Err("proxy mode must be auto or manual".to_owned()),
    };
    let check_address = |url: &Value| match url.as_str() {
        Some(text) => check_url(text)
            .map(|_| ())
            .map_err(|e| e.reason().to_owned()),
        None => Err("the proxy address must be a string".to_owned()),
    };
    match pointer {
        "/proxy" => {
            let object = value
                .as_object()
                .ok_or_else(|| "proxy must be an object".to_owned())?;
            for (key, member) in object {
                match key.as_str() {
                    "mode" => check_mode(member)?,
                    "url" => check_address(member)?,
                    other => return Err(format!("proxy has no member {other}")),
                }
            }
            Ok(())
        }
        "/proxy/mode" => check_mode(value),
        "/proxy/url" => check_address(value),
        other => Err(format!("{other} is not a proxy setting")),
    }
}

/// The proxy state Core keeps: the system's proxy as the main process last resolved it, and
/// the effective proxy the Agent Hosts were last told about.
#[derive(Debug, Default)]
pub struct Proxy {
    system: Mutex<Option<String>>,
    applied: Mutex<Option<String>>,
}

impl Proxy {
    /// The state at Core start: the user's choice as recorded in `data_dir`, no system proxy
    /// known yet (the main process reports it).
    #[must_use]
    pub fn starting(data_dir: &Path) -> Self {
        let proxy = Self::default();
        proxy.refresh(data_dir);
        proxy
    }

    /// Records the system's proxy (`None`: direct). An address PiArc cannot use (SOCKS, with
    /// credentials) counts as none. Returns whether the recorded value changed.
    pub fn set_system(&self, url: Option<&str>) -> bool {
        let next = url.and_then(|text| check_url(text).ok());
        let mut system = self
            .system
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = *system != next;
        *system = next;
        changed
    }

    /// The system's proxy as recorded.
    #[must_use]
    pub fn system(&self) -> Option<String> {
        self.system
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The proxy the Agent Hosts use now, from the user's settings in `data_dir` (`None`:
    /// direct). An unreadable settings file leaves the choice at `auto`.
    #[must_use]
    pub fn effective(&self, data_dir: &Path) -> Option<String> {
        let settings = crate::client_settings::read(data_dir).unwrap_or(Value::Null);
        match ProxySetting::of(&settings) {
            ProxySetting::Auto => self.system(),
            ProxySetting::Manual(url) if url.is_empty() => None,
            ProxySetting::Manual(url) => Some(url),
        }
    }

    /// Records the effective proxy now; returns whether it differs from the last one recorded
    /// (the running Agent Hosts then need a restart).
    pub fn refresh(&self, data_dir: &Path) -> bool {
        let now = self.effective(data_dir);
        let mut applied = self
            .applied
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = *applied != now;
        *applied = now;
        changed
    }

    /// The variables an Agent Host starts with for the effective proxy (none when direct).
    #[must_use]
    pub fn env(&self, data_dir: &Path) -> Vec<(OsString, OsString)> {
        env_for(self.effective(data_dir).as_deref())
    }
}

/// The variables for `proxy` (none for `None`).
#[must_use]
pub fn env_for(proxy: Option<&str>) -> Vec<(OsString, OsString)> {
    let Some(proxy) = proxy else {
        return Vec::new();
    };
    [
        ("HTTP_PROXY", proxy),
        ("HTTPS_PROXY", proxy),
        ("NO_PROXY", NO_PROXY),
        ("NODE_USE_ENV_PROXY", "1"),
    ]
    .into_iter()
    .map(|(name, value)| (OsString::from(name), OsString::from(value)))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_host_and_port_and_normalizes_it() {
        assert_eq!(
            check_url("http://127.0.0.1:7897").as_deref(),
            Ok("http://127.0.0.1:7897")
        );
        assert_eq!(
            check_url(" HTTPS://Proxy.Example.com/ ").as_deref(),
            Ok("https://proxy.example.com")
        );
        assert_eq!(
            check_url("http://[::1]:8080").as_deref(),
            Ok("http://[::1]:8080")
        );
        assert_eq!(
            check_url("http://corp-proxy").as_deref(),
            Ok("http://corp-proxy")
        );
    }

    #[test]
    fn refuses_what_is_not_a_plain_proxy_address() {
        assert_eq!(
            check_url("socks5://127.0.0.1:1080"),
            Err(ProxyUrlError::Scheme)
        );
        assert_eq!(check_url("127.0.0.1:7897"), Err(ProxyUrlError::Scheme));
        assert_eq!(
            check_url("http://user:secret@127.0.0.1:7897"),
            Err(ProxyUrlError::Credentials)
        );
        assert_eq!(
            check_url("http://127.0.0.1:7897/pac"),
            Err(ProxyUrlError::Path)
        );
        assert_eq!(check_url("http://127.0.0.1:0"), Err(ProxyUrlError::Port));
        assert_eq!(
            check_url("http://127.0.0.1:70000"),
            Err(ProxyUrlError::Port)
        );
        assert_eq!(check_url("http://:7897"), Err(ProxyUrlError::Host));
        assert_eq!(check_url("http://bad host:1"), Err(ProxyUrlError::Host));
        assert_eq!(check_url("http://[zz]:1"), Err(ProxyUrlError::Host));
    }

    #[test]
    fn reads_the_choice_with_auto_as_the_default() {
        assert_eq!(ProxySetting::of(&json!({})), ProxySetting::Auto);
        assert_eq!(
            ProxySetting::of(&json!({ "proxy": { "mode": "auto", "url": "http://a:1" } })),
            ProxySetting::Auto
        );
        assert_eq!(
            ProxySetting::of(&json!({ "proxy": { "mode": "manual", "url": "http://A:1/" } })),
            ProxySetting::Manual("http://a:1".into())
        );
        assert_eq!(
            ProxySetting::of(&json!({ "proxy": { "mode": "manual", "url": "ftp://a" } })),
            ProxySetting::Manual(String::new())
        );
    }

    #[test]
    fn checks_what_a_client_writes() {
        assert!(
            check_setting(
                "/proxy",
                Some(&json!({ "mode": "manual", "url": "http://a:1" }))
            )
            .is_ok()
        );
        assert!(check_setting("/proxy/mode", Some(&json!("auto"))).is_ok());
        assert!(check_setting("/proxy", None).is_ok());
        assert!(check_setting("/proxy/mode", Some(&json!("system"))).is_err());
        assert!(check_setting("/proxy/url", Some(&json!("http://u:p@a:1"))).is_err());
        assert!(check_setting("/proxy", Some(&json!({ "mode": "auto", "extra": 1 }))).is_err());
        assert!(check_setting("/proxy", Some(&json!("http://a:1"))).is_err());
    }

    #[test]
    fn the_effective_proxy_follows_the_choice_and_the_system() {
        let dir = std::env::temp_dir().join(format!("piarc proxy 代理 {}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let _ = std::fs::remove_file(dir.join("settings.json"));
        let proxy = Proxy::default();
        assert_eq!(proxy.effective(&dir), None);
        assert!(proxy.set_system(Some("http://127.0.0.1:7897")));
        assert!(!proxy.set_system(Some("HTTP://127.0.0.1:7897/")));
        assert_eq!(
            proxy.effective(&dir).as_deref(),
            Some("http://127.0.0.1:7897")
        );
        std::fs::write(
            dir.join("settings.json"),
            r#"{ "proxy": { "mode": "manual", "url": "http://10.0.0.2:3128" } }"#,
        )
        .expect("settings");
        assert_eq!(
            proxy.effective(&dir).as_deref(),
            Some("http://10.0.0.2:3128")
        );
        let env = proxy.env(&dir);
        assert!(env.contains(&("HTTPS_PROXY".into(), "http://10.0.0.2:3128".into())));
        assert!(env.contains(&("NO_PROXY".into(), NO_PROXY.into())));
        assert!(env.contains(&("NODE_USE_ENV_PROXY".into(), "1".into())));
        // A SOCKS system proxy is not one Node can use: direct.
        assert!(proxy.set_system(Some("socks5://127.0.0.1:1080")));
        assert_eq!(proxy.system(), None);
        std::fs::remove_dir_all(&dir).expect("clean up");
    }
}
