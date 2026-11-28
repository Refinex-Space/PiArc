//! Which addresses a fetch may connect to. Pure functions over resolved addresses, so every
//! range has a table-driven test; the fetcher connects only to the addresses they return.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::IpNet;

/// Why an address is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    Unspecified,
    Loopback,
    Private,
    LinkLocal,
    Multicast,
    Broadcast,
    /// Carrier-grade NAT, benchmarking, documentation and other ranges that are never a
    /// public web server.
    Reserved,
}

impl Blocked {
    pub fn describe(self) -> &'static str {
        match self {
            Self::Unspecified => "an unspecified address",
            Self::Loopback => "a loopback address",
            Self::Private => "a private network address",
            Self::LinkLocal => "a link-local address",
            Self::Multicast => "a multicast address",
            Self::Broadcast => "a broadcast address",
            Self::Reserved => "a reserved address",
        }
    }
}

/// Hosts and address ranges a fetch may reach although they are not public (tests, a user's
/// local server). Entries are host names (exact, case-insensitive, trailing dot ignored) or
/// IP addresses and CIDR ranges.
#[derive(Debug, Clone, Default)]
pub struct Allowlist {
    hosts: Vec<String>,
    nets: Vec<IpNet>,
}

impl Allowlist {
    /// The allowlist of `entries`; an entry that is neither a host name nor an address range is
    /// an error naming it.
    pub fn new(entries: &[String]) -> Result<Self, String> {
        let mut list = Self::default();
        for entry in entries {
            let entry = entry.trim();
            if let Ok(net) = entry.parse::<IpNet>() {
                list.nets.push(net);
            } else if let Ok(ip) = entry.trim_matches(['[', ']']).parse::<IpAddr>() {
                list.nets.push(IpNet::from(ip));
            } else if valid_host(entry) {
                list.hosts.push(normal_host(entry));
            } else {
                return Err(format!("invalid allowlist entry {entry:?}"));
            }
        }
        Ok(list)
    }

    pub fn allows_host(&self, host: &str) -> bool {
        let host = normal_host(host);
        self.hosts.contains(&host)
    }

    pub fn allows_ip(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.nets.iter().any(|net| net.contains(&ip))
    }
}

fn normal_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.trim_end_matches('.').split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// An IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible-by-NAT64 address checked as IPv4.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// Why `ip` is not a public address, or `None` when it is.
pub fn classify(ip: IpAddr) -> Option<Blocked> {
    match canonical(ip) {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(ip: Ipv4Addr) -> Option<Blocked> {
    let [a, b, c, _] = ip.octets();
    if ip.is_unspecified() || a == 0 {
        Some(Blocked::Unspecified)
    } else if ip.is_loopback() {
        Some(Blocked::Loopback)
    } else if ip.is_private() {
        Some(Blocked::Private)
    } else if ip.is_link_local() {
        Some(Blocked::LinkLocal)
    } else if ip.is_multicast() {
        Some(Blocked::Multicast)
    } else if ip.is_broadcast() {
        Some(Blocked::Broadcast)
    } else if (a == 100 && (64..128).contains(&b))      // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0)               // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2)               // TEST-NET-1
        || (a == 198 && (18..20).contains(&b))          // benchmarking
        || (a == 198 && b == 51 && c == 100)            // TEST-NET-2
        || (a == 203 && b == 0 && c == 113)             // TEST-NET-3
        || (a == 192 && b == 88 && c == 99)             // 6to4 relay anycast (deprecated)
        || a >= 240
    {
        Some(Blocked::Reserved)
    } else {
        None
    }
}

fn classify_v6(ip: Ipv6Addr) -> Option<Blocked> {
    let segments = ip.segments();
    if ip.is_unspecified() {
        return Some(Blocked::Unspecified);
    }
    if ip.is_loopback() {
        return Some(Blocked::Loopback);
    }
    if ip.is_multicast() {
        return Some(Blocked::Multicast);
    }
    // Embedded IPv4: IPv4-compatible (deprecated, ::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4
    // (2002::/16) are judged by the address inside.
    if segments[..6] == [0; 6] {
        let [a, b] = segments[6].to_be_bytes();
        let [c, d] = segments[7].to_be_bytes();
        return classify_v4(Ipv4Addr::new(a, b, c, d)).or(Some(Blocked::Reserved));
    }
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let [a, b] = segments[6].to_be_bytes();
        let [c, d] = segments[7].to_be_bytes();
        return classify_v4(Ipv4Addr::new(a, b, c, d));
    }
    if segments[0] == 0x2002 {
        let [a, b] = segments[1].to_be_bytes();
        let [c, d] = segments[2].to_be_bytes();
        return classify_v4(Ipv4Addr::new(a, b, c, d));
    }
    match segments[0] {
        s if s & 0xfe00 == 0xfc00 => Some(Blocked::Private), // unique local fc00::/7
        s if s & 0xffc0 == 0xfe80 => Some(Blocked::LinkLocal), // fe80::/10
        s if s & 0xffc0 == 0xfec0 => Some(Blocked::Private), // site-local (deprecated)
        0x0100 if segments[1..4] == [0, 0, 0] => Some(Blocked::Reserved), // discard 100::/64
        0x2001 if segments[1] == 0x0db8 => Some(Blocked::Reserved), // documentation
        0x2001 if segments[1] < 0x0200 => Some(Blocked::Reserved), // IETF protocol assignments, Teredo
        _ => None,
    }
}

/// The addresses of `host` a fetch may connect to: all of `resolved` when the host or each
/// address is allowlisted or public. One refused address refuses the host, so a name that
/// resolves to both a public and an internal address cannot be steered to the internal one.
pub fn check(
    host: &str,
    resolved: &[IpAddr],
    allow: &Allowlist,
) -> Result<Vec<IpAddr>, (IpAddr, Blocked)> {
    if allow.allows_host(host) {
        return Ok(resolved.to_vec());
    }
    for &ip in resolved {
        if let Some(why) = classify(ip).filter(|_| !allow.allows_ip(ip)) {
            return Err((ip, why));
        }
    }
    Ok(resolved.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn every_range_is_classified() {
        let cases: &[(&str, Option<Blocked>)] = &[
            ("0.0.0.0", Some(Blocked::Unspecified)),
            ("0.1.2.3", Some(Blocked::Unspecified)),
            ("127.0.0.1", Some(Blocked::Loopback)),
            ("127.255.255.254", Some(Blocked::Loopback)),
            ("10.0.0.1", Some(Blocked::Private)),
            ("172.16.0.1", Some(Blocked::Private)),
            ("172.31.255.255", Some(Blocked::Private)),
            ("192.168.1.1", Some(Blocked::Private)),
            ("169.254.169.254", Some(Blocked::LinkLocal)),
            ("224.0.0.1", Some(Blocked::Multicast)),
            ("239.255.255.250", Some(Blocked::Multicast)),
            ("255.255.255.255", Some(Blocked::Broadcast)),
            ("100.64.0.1", Some(Blocked::Reserved)),
            ("100.127.255.255", Some(Blocked::Reserved)),
            ("192.0.0.8", Some(Blocked::Reserved)),
            ("192.0.2.1", Some(Blocked::Reserved)),
            ("198.18.0.1", Some(Blocked::Reserved)),
            ("198.51.100.7", Some(Blocked::Reserved)),
            ("203.0.113.9", Some(Blocked::Reserved)),
            ("240.0.0.1", Some(Blocked::Reserved)),
            ("8.8.8.8", None),
            ("172.32.0.1", None),
            ("100.128.0.1", None),
            ("93.184.215.14", None),
            ("::", Some(Blocked::Unspecified)),
            ("::1", Some(Blocked::Loopback)),
            ("::ffff:127.0.0.1", Some(Blocked::Loopback)),
            ("::ffff:10.1.2.3", Some(Blocked::Private)),
            ("::ffff:169.254.169.254", Some(Blocked::LinkLocal)),
            ("::ffff:8.8.8.8", None),
            ("::127.0.0.1", Some(Blocked::Loopback)),
            ("::8.8.8.8", Some(Blocked::Reserved)),
            ("64:ff9b::a00:1", Some(Blocked::Private)),
            ("64:ff9b::808:808", None),
            ("2002:7f00:1::", Some(Blocked::Loopback)),
            ("2002:c0a8:101::1", Some(Blocked::Private)),
            ("fc00::1", Some(Blocked::Private)),
            ("fd12:3456::1", Some(Blocked::Private)),
            ("fe80::1", Some(Blocked::LinkLocal)),
            ("febf::1", Some(Blocked::LinkLocal)),
            ("fec0::1", Some(Blocked::Private)),
            ("ff02::1", Some(Blocked::Multicast)),
            ("100::1", Some(Blocked::Reserved)),
            ("2001:db8::1", Some(Blocked::Reserved)),
            ("2001::1", Some(Blocked::Reserved)),
            ("2606:4700::1111", None),
            ("2001:4860:4860::8888", None),
        ];
        for (text, expected) in cases {
            assert_eq!(classify(ip(text)), *expected, "{text}");
        }
    }

    #[test]
    fn one_internal_address_refuses_the_host() {
        let none = Allowlist::default();
        assert_eq!(
            check("mixed.test", &[ip("8.8.8.8"), ip("10.0.0.2")], &none),
            Err((ip("10.0.0.2"), Blocked::Private))
        );
        assert_eq!(
            check("pub.test", &[ip("8.8.8.8")], &none),
            Ok(vec![ip("8.8.8.8")])
        );
    }

    #[test]
    fn allowlisted_hosts_and_ranges_pass() {
        let allow = Allowlist::new(&[
            "127.0.0.1".into(),
            "10.1.0.0/16".into(),
            "Intranet.Test.".into(),
            "[::1]".into(),
        ])
        .unwrap();
        assert!(check("x.test", &[ip("127.0.0.1")], &allow).is_ok());
        assert!(check("x.test", &[ip("::ffff:127.0.0.1")], &allow).is_ok());
        assert!(check("x.test", &[ip("::1")], &allow).is_ok());
        assert!(check("x.test", &[ip("10.1.200.3")], &allow).is_ok());
        assert!(check("x.test", &[ip("10.2.0.1")], &allow).is_err());
        assert!(check("intranet.test", &[ip("192.168.0.9")], &allow).is_ok());
        assert!(check("other.test", &[ip("192.168.0.9")], &allow).is_err());
        assert!(Allowlist::new(&["not a host".into()]).is_err());
    }
}
