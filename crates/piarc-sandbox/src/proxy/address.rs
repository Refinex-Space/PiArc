//! Destination addresses the proxy refuses whatever the allowlist says.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Cloud instance metadata services outside the link-local range.
const METADATA_V4: [Ipv4Addr; 3] = [
    // Alibaba Cloud.
    Ipv4Addr::new(100, 100, 100, 200),
    // Azure wire server.
    Ipv4Addr::new(168, 63, 129, 16),
    // Oracle Cloud.
    Ipv4Addr::new(192, 0, 0, 192),
];

/// AWS's IPv6 instance metadata endpoint.
const METADATA_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254);

/// Why `ip` may not be a proxy destination, or `None` when it may: loopback and unspecified
/// addresses reach the user's own machine (including services listening only locally),
/// link-local addresses include `169.254.169.254`, the metadata service of AWS, GCP and
/// Azure, and a few providers serve metadata elsewhere.
#[must_use]
pub fn blocked_reason(ip: IpAddr) -> Option<&'static str> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    };
    match ip {
        IpAddr::V4(v4) if v4.is_loopback() => Some("loopback address"),
        IpAddr::V4(v4) if v4.is_unspecified() => Some("unspecified address"),
        IpAddr::V4(v4) if v4.is_link_local() => Some("link-local address (cloud metadata)"),
        IpAddr::V4(v4) if METADATA_V4.contains(&v4) => Some("cloud metadata address"),
        IpAddr::V6(v6) if v6.is_loopback() => Some("loopback address"),
        IpAddr::V6(v6) if v6.is_unspecified() => Some("unspecified address"),
        IpAddr::V6(v6) if v6.is_unicast_link_local() => Some("link-local address (cloud metadata)"),
        IpAddr::V6(v6) if v6 == METADATA_V6 => Some("cloud metadata address"),
        _ => None,
    }
}

/// Whether `ip` is in a private network range (RFC 1918, carrier-grade NAT, IPv6 unique local),
/// IPv4-mapped forms included.
#[must_use]
pub(super) fn is_private(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    };
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private() || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// Whether `ip` is a loopback address, IPv4-mapped forms included.
#[must_use]
pub(super) fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map_or_else(|| v6.is_loopback(), |v4| v4.is_loopback()),
        IpAddr::V4(v4) => v4.is_loopback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_metadata_addresses_are_blocked() {
        for ip in [
            "127.0.0.1",
            "127.8.9.10",
            "::1",
            "0.0.0.0",
            "::",
            "169.254.169.254",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "100.100.100.200",
            "fd00:ec2::254",
        ] {
            let ip: IpAddr = ip.parse().expect("an address");
            assert!(blocked_reason(ip).is_some(), "{ip}");
        }
    }

    #[test]
    fn public_and_private_addresses_pass() {
        for ip in ["203.0.113.7", "10.0.0.5", "192.168.1.2", "2001:db8::1"] {
            let ip: IpAddr = ip.parse().expect("an address");
            assert_eq!(blocked_reason(ip), None, "{ip}");
        }
    }
}
