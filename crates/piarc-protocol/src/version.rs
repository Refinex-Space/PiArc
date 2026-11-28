//! Protocol version, capabilities and handshake negotiation.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{Error, Result};

/// The AHP version spoken by this build. This is the only place the version is defined;
/// `npm run gen:protocol` copies it into `@piarc/protocol` as `PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };

/// A `major.minor` protocol version, serialized as a string such as `"1.0"`.
///
/// Peers with different major versions cannot talk to each other. Peers with different
/// minor versions can; anything a newer minor adds is gated behind a capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProtocolVersion {
    /// Incremented for incompatible changes.
    pub major: u32,
    /// Incremented for backward-compatible additions.
    pub minor: u32,
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

impl FromStr for ProtocolVersion {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        let invalid = || format!("invalid protocol version {s:?}; expected \"major.minor\"");
        let (major, minor) = s.split_once('.').ok_or_else(invalid)?;
        Ok(Self {
            major: parse_component(major).ok_or_else(invalid)?,
            minor: parse_component(minor).ok_or_else(invalid)?,
        })
    }
}

/// Parses one version component: ASCII digits without a leading zero (except `0` itself),
/// matching the schema pattern.
fn parse_component(s: &str) -> Option<u32> {
    let well_formed =
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    if well_formed { s.parse().ok() } else { None }
}

impl Serialize for ProtocolVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let s = Cow::<str>::deserialize(deserializer)?;
        s.parse().map_err(D::Error::custom)
    }
}

impl JsonSchema for ProtocolVersion {
    fn schema_name() -> Cow<'static, str> {
        "ProtocolVersion".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "Protocol version as \"major.minor\", for example \"1.0\".",
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
        })
    }
}

/// A named optional protocol feature, for example `planMode`.
///
/// Capabilities are open strings rather than an enum: a peer must accept capability names
/// it does not know, because that is how newer minor versions announce additions.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(transparent)]
#[schemars(transparent)]
pub struct Capability(pub String);

impl Capability {
    /// Creates a capability from its name.
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    /// The capability name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Negotiates a connection between this side (`local`) and its peer (`remote`).
///
/// Returns the capabilities both sides support, in `local` order without duplicates.
/// Differing minor versions are allowed: the intersection already excludes anything only
/// the newer side knows.
///
/// # Errors
///
/// [`Error::VersionMismatch`] (kind `protocolVersionMismatch`, not retryable) when the major
/// versions differ.
pub fn negotiate(
    local: ProtocolVersion,
    local_capabilities: &[Capability],
    remote: ProtocolVersion,
    remote_capabilities: &[Capability],
) -> Result<Vec<Capability>> {
    if local.major != remote.major {
        return Err(Error::VersionMismatch { local, remote });
    }
    let mut enabled: Vec<Capability> = Vec::new();
    for capability in local_capabilities {
        if remote_capabilities.contains(capability) && !enabled.contains(capability) {
            enabled.push(capability.clone());
        }
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc_error::ErrorKind;

    fn v(major: u32, minor: u32) -> ProtocolVersion {
        ProtocolVersion { major, minor }
    }

    fn caps(names: &[&str]) -> Vec<Capability> {
        names.iter().map(|n| Capability::new(*n)).collect()
    }

    #[test]
    fn rejects_a_different_major_version_with_a_structured_error() {
        let error = negotiate(v(1, 0), &caps(&["todo"]), v(2, 0), &caps(&["todo"]))
            .expect_err("major mismatch must fail");
        assert_eq!(error.kind(), ErrorKind::ProtocolVersionMismatch);
        assert!(!error.retryable());
        let object = serde_json::to_value(error.to_error_object()).expect("serializes");
        assert_eq!(
            object,
            serde_json::json!({
                "code": -32000,
                "message": error.to_string(),
                "data": {
                    "kind": "protocolVersionMismatch",
                    "retryable": false,
                    "details": { "local": "1.0", "remote": "2.0" }
                }
            })
        );
    }

    #[test]
    fn accepts_a_different_minor_version_and_enables_the_intersection() {
        let enabled = negotiate(
            v(1, 3),
            &caps(&["subagents", "planMode", "todo", "mcpPool"]),
            v(1, 1),
            &caps(&["todo", "planMode", "unknownToCore"]),
        )
        .expect("minor mismatch is allowed");
        assert_eq!(enabled, caps(&["planMode", "todo"]));
    }

    #[test]
    fn deduplicates_enabled_capabilities() {
        let enabled = negotiate(v(1, 0), &caps(&["todo", "todo"]), v(1, 0), &caps(&["todo"]))
            .expect("same version");
        assert_eq!(enabled, caps(&["todo"]));
    }

    #[test]
    fn parses_and_prints_versions() {
        assert_eq!("1.0".parse::<ProtocolVersion>(), Ok(v(1, 0)));
        assert_eq!("10.25".parse::<ProtocolVersion>(), Ok(v(10, 25)));
        assert_eq!(v(3, 7).to_string(), "3.7");
        for bad in [
            "1", "1.", ".1", "01.0", "1.0.0", "a.b", "1.-1", " 1.0", "+1.0",
        ] {
            assert!(
                bad.parse::<ProtocolVersion>().is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn serializes_versions_as_strings() {
        let json = serde_json::to_value(PROTOCOL_VERSION).expect("serializes");
        assert_eq!(json, serde_json::json!(PROTOCOL_VERSION.to_string()));
        assert!(serde_json::from_value::<ProtocolVersion>(serde_json::json!(1)).is_err());
    }
}
