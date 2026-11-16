//! Environment variables of sandboxed commands: the proxy, the temporary directory and the
//! package-manager caches.
//!
//! `GIT_CONFIG_COUNT` replaces any the command inherits: git configuration passed that way is
//! not available inside the sandbox.
//!
//! Caches go to `<session tmp>/cache/` instead of the user's directories. A writable shared
//! cache would let a sandboxed command plant code that runs later outside the sandbox: an
//! unpacked crate in `~/.cargo/registry/src` is compiled (and its `build.rs` run) by the next
//! unsandboxed `cargo build` without any check. The price is a cold cache in every session and,
//! for Cargo, that `CARGO_HOME` moves: `~/.cargo/config.toml` (registry mirrors) and
//! credentials are not read inside the sandbox. T39 decides whether to carry the user's Cargo
//! configuration over.

use std::ffi::OsString;
use std::path::Path;

/// The variables a sandboxed command gets on top of its normal environment, replacing any of
/// the same name.
#[must_use]
pub fn sandbox_env(session_tmp: &Path, proxy_port: u16) -> Vec<(OsString, OsString)> {
    let proxy = OsString::from(format!("http://127.0.0.1:{proxy_port}"));
    let cache = session_tmp.join("cache");
    let mut env: Vec<(OsString, OsString)> = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]
    .into_iter()
    .map(|name| (OsString::from(name), proxy.clone()))
    .collect();
    // Tools whose own configuration outranks the variables above: Cargo and git read
    // `http.proxy` from the user's git configuration before the environment, npm reads
    // `.npmrc`. Their environment overrides win over every configuration file.
    let overrides = [
        ("CARGO_HTTP_PROXY", proxy.clone()),
        ("npm_config_proxy", proxy.clone()),
        ("npm_config_https_proxy", proxy.clone()),
        ("PIP_PROXY", proxy.clone()),
        ("GIT_CONFIG_COUNT", OsString::from("2")),
        ("GIT_CONFIG_KEY_0", OsString::from("http.proxy")),
        ("GIT_CONFIG_VALUE_0", proxy.clone()),
        ("GIT_CONFIG_KEY_1", OsString::from("https.proxy")),
        ("GIT_CONFIG_VALUE_1", proxy.clone()),
    ];
    env.extend(
        overrides
            .into_iter()
            .map(|(name, value)| (OsString::from(name), value)),
    );
    let fixed = [
        // An inherited bypass list must not send anything around the proxy (it would fail
        // anyway: the sandbox allows no other connection).
        ("NO_PROXY", OsString::new()),
        ("no_proxy", OsString::new()),
        // Node's built-in fetch reads the proxy variables only with this (Node 24).
        ("NODE_USE_ENV_PROXY", OsString::from("1")),
        ("TMPDIR", session_tmp.as_os_str().to_owned()),
        ("XDG_CACHE_HOME", cache.as_os_str().to_owned()),
        ("npm_config_cache", cache.join("npm").into_os_string()),
        ("CARGO_HOME", cache.join("cargo").into_os_string()),
        ("PIP_CACHE_DIR", cache.join("pip").into_os_string()),
        ("GOCACHE", cache.join("go-build").into_os_string()),
        ("GOMODCACHE", cache.join("go-mod").into_os_string()),
    ];
    env.extend(
        fixed
            .into_iter()
            .map(|(name, value)| (OsString::from(name), value)),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_and_caches_point_into_the_session() {
        let tmp = Path::new("/data/sessions/s 1/tmp");
        let env = sandbox_env(tmp, 4321);
        let get = |name: &str| {
            env.iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{name} is set"))
        };
        for name in [
            "HTTP_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "CARGO_HTTP_PROXY",
            "npm_config_https_proxy",
            "GIT_CONFIG_VALUE_0",
        ] {
            assert_eq!(get(name), "http://127.0.0.1:4321");
        }
        assert_eq!(get("NO_PROXY"), "");
        assert_eq!(get("TMPDIR"), tmp.as_os_str());
        assert_eq!(
            get("CARGO_HOME"),
            tmp.join("cache").join("cargo").as_os_str()
        );
        assert_eq!(
            get("npm_config_cache"),
            tmp.join("cache").join("npm").as_os_str()
        );
    }
}
