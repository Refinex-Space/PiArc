//! JSON-RPC 2.0 message envelopes.
//!
//! AHP uses requests, responses and notifications in both directions. Batches are not
//! supported: [`Message::from_value`] rejects a JSON array with an `invalidRequest` error,
//! which the receiver answers with a JSON-RPC Invalid Request error response (`id: null`).
//! Parameters are always by name (`params` is an object when present).

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::rpc_error::ErrorObject;

/// The `jsonrpc` member. Serializes as `"2.0"` and accepts nothing else.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Version;

impl Version {
    /// The only accepted value.
    pub const VALUE: &'static str = "2.0";
}

impl Serialize for Version {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(Self::VALUE)
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let s = Cow::<str>::deserialize(deserializer)?;
        if s == Self::VALUE {
            Ok(Self)
        } else {
            Err(D::Error::custom(format!(
                "unsupported jsonrpc version {s:?}; expected \"2.0\""
            )))
        }
    }
}

impl JsonSchema for Version {
    fn schema_name() -> Cow<'static, str> {
        "JsonRpcVersion".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "const": Self::VALUE })
    }
}

/// A request id: an integer or a string. `null` and fractional numbers are not accepted.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    /// Integer id.
    Number(i64),
    /// String id.
    String(String),
}

/// A request whose method is not interpreted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// Correlates the response with this request.
    pub id: RequestId,
    /// Method name, for example `host/hello`.
    pub method: String,
    /// Named parameters. When present it must be an object (`null` is rejected).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "params_object"
    )]
    #[schemars(with = "Map<String, Value>")]
    pub params: Option<Map<String, Value>>,
}

/// A notification (no `id`, no response) whose method is not interpreted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// Method name, for example `turn/started`.
    pub method: String,
    /// Named parameters. When present it must be an object (`null` is rejected).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "params_object"
    )]
    #[schemars(with = "Map<String, Value>")]
    pub params: Option<Map<String, Value>>,
}

/// A successful response. It has `result` and must not have `error`.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = forbid_error)]
pub struct SuccessResponse {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// The id of the request being answered.
    pub id: RequestId,
    /// The method's result; any JSON value, including `null`.
    pub result: Value,
}

/// An error response. It has `error` and must not have `result`.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(transform = forbid_result)]
pub struct ErrorResponse {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// The id of the request being answered; `null` when it could not be determined (for
    /// example a parse error). The member itself is required.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(schema_with = "nullable_request_id")]
    pub id: Option<RequestId>,
    /// The structured error.
    pub error: ErrorObject,
}

/// Marks `member` as forbidden (`"member": false` under `properties`): `result` and `error`
/// are exclusive.
pub(crate) fn forbid_member(schema: &mut Schema, member: &str) {
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        properties.insert(member.to_owned(), Value::Bool(false));
    }
}

fn forbid_error(schema: &mut Schema) {
    forbid_member(schema, "error");
}

fn forbid_result(schema: &mut Schema) {
    forbid_member(schema, "result");
}

/// `params` is optional, but when present it must be an object.
fn params_object<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Map<String, Value>>, D::Error> {
    Map::deserialize(deserializer).map(Some)
}

fn nullable_request_id(generator: &mut SchemaGenerator) -> Schema {
    json_schema!({ "anyOf": [generator.subschema_for::<RequestId>(), { "type": "null" }] })
}

/// Private mirrors used to deserialize responses after the `result`/`error` exclusivity
/// check. `deserialize_with` makes a missing member an error instead of `null`.
mod repr {
    use super::{Deserialize, ErrorObject, RequestId, Value, Version};

    #[derive(Deserialize)]
    pub(super) struct Success {
        pub jsonrpc: Version,
        pub id: RequestId,
        #[serde(deserialize_with = "Value::deserialize")]
        pub result: Value,
    }

    #[derive(Deserialize)]
    pub(super) struct Failure {
        pub jsonrpc: Version,
        #[serde(deserialize_with = "Option::deserialize")]
        pub id: Option<RequestId>,
        pub error: ErrorObject,
    }
}

fn response_object<E: serde::de::Error>(
    map: Map<String, Value>,
    forbidden: &str,
    kind: &str,
) -> std::result::Result<Value, E> {
    if map.contains_key(forbidden) {
        return Err(E::custom(format!(
            "{kind} response must not contain `{forbidden}`; `result` and `error` are exclusive"
        )));
    }
    Ok(Value::Object(map))
}

impl<'de> Deserialize<'de> for SuccessResponse {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let value = response_object(map, "error", "a success")?;
        let repr: repr::Success = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self {
            jsonrpc: repr.jsonrpc,
            id: repr.id,
            result: repr.result,
        })
    }
}

impl<'de> Deserialize<'de> for ErrorResponse {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let value = response_object(map, "result", "an error")?;
        let repr: repr::Failure = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self {
            jsonrpc: repr.jsonrpc,
            id: repr.id,
            error: repr.error,
        })
    }
}

/// Any AHP JSON-RPC message, classified by its members.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Message {
    /// Has `method` and `id`.
    Request(Request),
    /// Has `method` and no `id`.
    Notification(Notification),
    /// Has `result` and no `method`.
    Success(SuccessResponse),
    /// Has `error` and no `method`.
    Error(ErrorResponse),
}

impl Message {
    /// Classifies and validates one decoded frame.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidRequest`] when the value is a batch (JSON array), not an object, or
    /// not a well-formed request, notification or response.
    pub fn from_value(value: Value) -> Result<Self> {
        let map = match value {
            Value::Object(map) => map,
            Value::Array(_) => {
                return Err(invalid("batch requests are not supported".to_owned()));
            }
            other => {
                return Err(invalid(format!(
                    "a message must be a JSON object, got {}",
                    json_type(&other)
                )));
            }
        };
        let has_method = map.contains_key("method");
        let has_id = map.contains_key("id");
        let has_result = map.contains_key("result");
        let has_error = map.contains_key("error");
        let value = Value::Object(map);
        let parsed = if has_method {
            if has_id {
                serde_json::from_value(value).map(Self::Request)
            } else {
                serde_json::from_value(value).map(Self::Notification)
            }
        } else if has_result {
            serde_json::from_value(value).map(Self::Success)
        } else if has_error {
            serde_json::from_value(value).map(Self::Error)
        } else {
            return Err(invalid(
                "a message needs `method`, `result` or `error`".to_owned(),
            ));
        };
        parsed.map_err(|e| invalid(e.to_string()))
    }
}

fn invalid(reason: String) -> Error {
    Error::InvalidRequest { reason }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rpc_error::ErrorKind;

    #[test]
    fn rejects_a_batch_as_an_invalid_request() {
        let batch = json!([{ "jsonrpc": "2.0", "id": 1, "method": "host/ping" }]);
        let error = Message::from_value(batch).expect_err("batches are not supported");
        assert_eq!(error.kind(), ErrorKind::InvalidRequest);
        assert_eq!(error.to_error_object().code, -32600);
    }

    #[test]
    fn classifies_each_message_kind() {
        let cases = [
            json!({ "jsonrpc": "2.0", "id": "a", "method": "m" }),
            json!({ "jsonrpc": "2.0", "method": "m", "params": {} }),
            json!({ "jsonrpc": "2.0", "id": 1, "result": null }),
            json!({ "jsonrpc": "2.0", "id": null, "error": {
                "code": -32700, "message": "bad", "data": { "kind": "parseError", "retryable": false }
            }}),
        ];
        let kinds: Vec<&str> = cases
            .iter()
            .map(
                |v| match Message::from_value(v.clone()).expect("valid message") {
                    Message::Request(_) => "request",
                    Message::Notification(_) => "notification",
                    Message::Success(_) => "success",
                    Message::Error(_) => "error",
                },
            )
            .collect();
        assert_eq!(kinds, ["request", "notification", "success", "error"]);
    }

    #[test]
    fn serializes_back_to_the_same_json() {
        let value = json!({ "jsonrpc": "2.0", "id": 7, "method": "m", "params": { "a": 1 } });
        let message = Message::from_value(value.clone()).expect("valid");
        assert_eq!(serde_json::to_value(message).expect("serializes"), value);
    }

    #[test]
    fn rejects_responses_with_both_or_neither_result_and_error() {
        let error = json!({ "code": -32603, "message": "x",
            "data": { "kind": "internalError", "retryable": false } });
        let both = json!({ "jsonrpc": "2.0", "id": 1, "result": 1, "error": error });
        let neither = json!({ "jsonrpc": "2.0", "id": 1 });
        for value in [both.clone(), neither] {
            assert!(Message::from_value(value.clone()).is_err(), "{value}");
        }
        assert!(serde_json::from_value::<SuccessResponse>(both.clone()).is_err());
        assert!(serde_json::from_value::<ErrorResponse>(both).is_err());
    }

    #[test]
    fn requires_result_and_id_members_to_be_present() {
        let no_result = json!({ "jsonrpc": "2.0", "id": 1, "error": null });
        let null_params = json!({ "jsonrpc": "2.0", "method": "m", "params": null });
        assert!(serde_json::from_value::<Notification>(null_params).is_err());
        assert!(
            serde_json::from_value::<SuccessResponse>(json!({ "jsonrpc": "2.0", "id": 1 }))
                .is_err()
        );
        assert!(serde_json::from_value::<ErrorResponse>(no_result).is_err());
        let no_id = json!({ "jsonrpc": "2.0", "error": {
            "code": -32700, "message": "bad", "data": { "kind": "parseError", "retryable": false }
        }});
        assert!(serde_json::from_value::<ErrorResponse>(no_id).is_err());
    }

    #[test]
    fn rejects_other_jsonrpc_versions_and_fractional_ids() {
        let wrong_version = json!({ "jsonrpc": "1.0", "id": 1, "method": "m" });
        let fractional_id = json!({ "jsonrpc": "2.0", "id": 1.5, "method": "m" });
        let null_id = json!({ "jsonrpc": "2.0", "id": null, "method": "m" });
        for value in [wrong_version, fractional_id, null_id] {
            assert!(Message::from_value(value.clone()).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_non_object_messages() {
        for value in [json!(null), json!(1), json!("x")] {
            let error = Message::from_value(value).expect_err("not an object");
            assert_eq!(error.kind(), ErrorKind::InvalidRequest);
        }
    }
}
