//! Address rules of a browser partition's proxy (ADR-0088).
//!
//! The built-in browser sends every non-loopback request of its partitions through a proxy
//! like the sandbox's. Which hosts the agent may reach is decided per tab in the main process;
//! the proxy only checks where a name really leads, after resolving it once:
//!
//! - cloud metadata, link-local and unspecified addresses are refused for every name;
//! - a loopback address is refused unless the name is an IP literal, `localhost`, a
//!   `*.localhost` name or a configured local development name (`*.test`, `*.local`): a public
//!   name that resolves to this machine is DNS rebinding, not a development server;
//! - PiArc's own listening ports are refused on loopback whatever the name;
//! - private addresses pass (intranet sites, LAN development servers), as for the sandbox.

use std::net::{IpAddr, SocketAddr};

use super::address::{blocked_reason, is_loopback};
use super::allowlist::Allowlist;

/// What a browser proxy lets through beyond public and private addresses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserPolicy {
    /// Names that may resolve to loopback (local development domains).
    pub local_names: Allowlist,
    /// Loopback ports nobody reaches through the browser: PiArc's own listeners.
    pub denied_ports: Vec<u16>,
}

impl BrowserPolicy {
    /// Why `host` may not connect to `addr`, or `None` when it may.
    #[must_use]
    pub fn blocked_reason(&self, host: &str, addr: SocketAddr) -> Option<&'static str> {
        let reason = blocked_reason(addr.ip())?;
        if !is_loopback(addr.ip()) {
            return Some(reason);
        }
        if self.denied_ports.contains(&addr.port()) {
            return Some("port that PiArc itself listens on");
        }
        if self.local_name(host) {
            None
        } else {
            Some("loopback address behind a name that is not local")
        }
    }

    fn local_name(&self, host: &str) -> bool {
        let name = host.trim_end_matches('.').to_ascii_lowercase();
        name.parse::<IpAddr>().is_ok()
            || name == "localhost"
            || name.ends_with(".localhost")
            || self.local_names.allows(&name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> BrowserPolicy {
        BrowserPolicy {
            local_names: Allowlist::new(["*.test"]).expect("valid"),
            denied_ports: vec![4100],
        }
    }

    fn at(ip: &str, port: u16) -> SocketAddr {
        SocketAddr::new(ip.parse().expect("an address"), port)
    }

    #[test]
    fn public_and_private_addresses_pass_for_any_name() {
        let policy = policy();
        assert_eq!(
            policy.blocked_reason("docs.example", at("203.0.113.7", 443)),
            None
        );
        assert_eq!(policy.blocked_reason("wiki.corp", at("10.0.0.5", 80)), None);
    }

    #[test]
    fn metadata_and_link_local_are_refused_for_any_name() {
        let policy = policy();
        for host in ["169.254.169.254", "metadata.example", "app.test"] {
            assert!(
                policy
                    .blocked_reason(host, at("169.254.169.254", 80))
                    .is_some()
            );
            assert!(
                policy
                    .blocked_reason(host, at("fd00:ec2::254", 80))
                    .is_some()
            );
        }
        assert!(policy.blocked_reason("any", at("0.0.0.0", 80)).is_some());
    }

    #[test]
    fn loopback_needs_a_local_name() {
        let policy = policy();
        for host in [
            "127.0.0.1",
            "::1",
            "localhost",
            "LocalHost.",
            "web.localhost",
            "app.test",
        ] {
            assert_eq!(
                policy.blocked_reason(host, at("127.0.0.1", 5173)),
                None,
                "{host}"
            );
        }
        for host in ["evil.example", "rebind.attacker.com", "test"] {
            assert!(
                policy.blocked_reason(host, at("127.0.0.1", 5173)).is_some(),
                "{host}"
            );
            assert!(
                policy
                    .blocked_reason(host, at("::ffff:127.0.0.1", 80))
                    .is_some(),
                "{host}"
            );
        }
    }

    #[test]
    fn piarc_ports_are_refused_on_loopback_only() {
        let policy = policy();
        assert!(
            policy
                .blocked_reason("localhost", at("127.0.0.1", 4100))
                .is_some()
        );
        assert!(policy.blocked_reason("app.test", at("::1", 4100)).is_some());
        assert_eq!(
            policy.blocked_reason("docs.example", at("203.0.113.7", 4100)),
            None
        );
    }
}
