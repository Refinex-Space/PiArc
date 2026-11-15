//! Typed method definitions and the wire messages built from them.
//!
//! Each AHP method is a marker type implementing [`RequestMethod`] or
//! [`NotificationMethod`]. [`RequestMessage`], [`ResultMessage`] and
//! [`NotificationMessage`] wrap the method's parameter and result types into complete
//! JSON-RPC messages whose `method` member is fixed to the method name, both in serde and
//! in the exported JSON Schema.

use std::borrow::Cow;
use std::fmt;
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::jsonrpc::{RequestId, Version};

/// Common part of every method definition.
pub trait Method {
    /// Wire name, for example `item/agentMessage/delta`.
    const NAME: &'static str;
    /// `UpperCamelCase` stem for generated schema names, for example `ItemAgentMessageDelta`
    /// (giving `ItemAgentMessageDeltaNotification`).
    const TYPE_NAME: &'static str;
}

/// A method that expects a response.
pub trait RequestMethod: Method {
    /// Parameter object.
    type Params: Serialize + for<'de> Deserialize<'de> + JsonSchema;
    /// Result of a successful response.
    type Result: Serialize + for<'de> Deserialize<'de> + JsonSchema;
}

/// A method sent as a notification.
pub trait NotificationMethod: Method {
    /// Parameter object.
    type Params: Serialize + for<'de> Deserialize<'de> + JsonSchema;
}

/// The `method` member of a typed message: serializes as `M::NAME` and accepts nothing else.
pub struct MethodName<M>(PhantomData<M>);

impl<M> MethodName<M> {
    /// Creates the marker.
    #[must_use]
    pub const fn new() -> Self {
        Self(PhantomData)
    }
}

impl<M> Default for MethodName<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> Clone for MethodName<M> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<M> Copy for MethodName<M> {}

impl<M> PartialEq for MethodName<M> {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl<M: Method> fmt::Debug for MethodName<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(M::NAME)
    }
}

impl<M: Method> Serialize for MethodName<M> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(M::NAME)
    }
}

impl<'de, M: Method> Deserialize<'de> for MethodName<M> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let name = Cow::<str>::deserialize(deserializer)?;
        if name == M::NAME {
            Ok(Self::new())
        } else {
            Err(D::Error::custom(format!(
                "expected method {:?}, got {name:?}",
                M::NAME
            )))
        }
    }
}

impl<M: Method> JsonSchema for MethodName<M> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("{}Method", M::TYPE_NAME).into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "const": M::NAME })
    }
}

/// Defines the marker type of a request method: `request!(/// docs Marker, "name", Params,
/// Result);`. The marker's `TYPE_NAME` is its own name.
macro_rules! request {
    ($(#[$doc:meta])* $marker:ident, $name:literal, $params:ty, $result:ty) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy)]
        pub struct $marker;

        impl $crate::method::Method for $marker {
            const NAME: &'static str = $name;
            const TYPE_NAME: &'static str = stringify!($marker);
        }

        impl $crate::method::RequestMethod for $marker {
            type Params = $params;
            type Result = $result;
        }
    };
}
pub(crate) use request;

/// A request for method `M`.
#[derive(Serialize, Deserialize)]
#[serde(bound(serialize = "", deserialize = ""))]
pub struct RequestMessage<M: RequestMethod> {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// Correlates the response with this request.
    pub id: RequestId,
    /// Always `M::NAME`.
    pub method: MethodName<M>,
    /// The method's parameters.
    pub params: M::Params,
}

/// A successful response to method `M`. Like [`crate::jsonrpc::SuccessResponse`], it must
/// not contain `error`.
#[derive(Serialize)]
#[serde(bound(serialize = ""))]
pub struct ResultMessage<M: RequestMethod> {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// The id of the request being answered.
    pub id: RequestId,
    /// The method's result.
    pub result: M::Result,
}

/// A notification for method `M`.
#[derive(Serialize, Deserialize)]
#[serde(bound(serialize = "", deserialize = ""))]
pub struct NotificationMessage<M: NotificationMethod> {
    /// Always `"2.0"`.
    pub jsonrpc: Version,
    /// Always `M::NAME`.
    pub method: MethodName<M>,
    /// The method's parameters.
    pub params: M::Params,
}

/// Private mirror of [`ResultMessage`] used after the `error` exclusivity check.
#[derive(Deserialize)]
#[serde(bound(deserialize = ""))]
struct ResultRepr<M: RequestMethod> {
    jsonrpc: Version,
    id: RequestId,
    result: M::Result,
}

impl<'de, M: RequestMethod> Deserialize<'de> for ResultMessage<M> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        if map.contains_key("error") {
            return Err(D::Error::custom(
                "a success response must not contain `error`; `result` and `error` are exclusive",
            ));
        }
        let repr: ResultRepr<M> =
            serde_json::from_value(serde_json::Value::Object(map)).map_err(D::Error::custom)?;
        Ok(Self {
            jsonrpc: repr.jsonrpc,
            id: repr.id,
            result: repr.result,
        })
    }
}

impl<M: RequestMethod> RequestMessage<M> {
    /// Builds a request.
    #[must_use]
    pub fn new(id: RequestId, params: M::Params) -> Self {
        Self {
            jsonrpc: Version,
            id,
            method: MethodName::new(),
            params,
        }
    }
}

impl<M: RequestMethod> ResultMessage<M> {
    /// Builds a successful response.
    #[must_use]
    pub fn new(id: RequestId, result: M::Result) -> Self {
        Self {
            jsonrpc: Version,
            id,
            result,
        }
    }
}

impl<M: NotificationMethod> NotificationMessage<M> {
    /// Builds a notification.
    #[must_use]
    pub fn new(params: M::Params) -> Self {
        Self {
            jsonrpc: Version,
            method: MethodName::new(),
            params,
        }
    }
}

fn message_schema(
    generator: &mut SchemaGenerator,
    description: String,
    members: Vec<(&'static str, Schema)>,
) -> Schema {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    properties.insert(
        "jsonrpc".to_owned(),
        generator.subschema_for::<Version>().into(),
    );
    required.push("jsonrpc");
    for (name, schema) in members {
        properties.insert(name.to_owned(), schema.into());
        required.push(name);
    }
    json_schema!({
        "description": description,
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

impl<M: RequestMethod> JsonSchema for RequestMessage<M> {
    fn schema_name() -> Cow<'static, str> {
        format!("{}Request", M::TYPE_NAME).into()
    }

    fn schema_id() -> Cow<'static, str> {
        format!("piarc_protocol::RequestMessage<{}>", M::NAME).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let members = vec![
            ("id", generator.subschema_for::<RequestId>()),
            ("method", generator.subschema_for::<MethodName<M>>()),
            ("params", generator.subschema_for::<M::Params>()),
        ];
        message_schema(generator, format!("Request for `{}`.", M::NAME), members)
    }
}

impl<M: RequestMethod> JsonSchema for ResultMessage<M> {
    fn schema_name() -> Cow<'static, str> {
        format!("{}Response", M::TYPE_NAME).into()
    }

    fn schema_id() -> Cow<'static, str> {
        format!("piarc_protocol::ResultMessage<{}>", M::NAME).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let members = vec![
            ("id", generator.subschema_for::<RequestId>()),
            ("result", generator.subschema_for::<M::Result>()),
        ];
        let mut schema = message_schema(
            generator,
            format!("Successful response to `{}`.", M::NAME),
            members,
        );
        crate::jsonrpc::forbid_member(&mut schema, "error");
        schema
    }
}

impl<M: NotificationMethod> JsonSchema for NotificationMessage<M> {
    fn schema_name() -> Cow<'static, str> {
        format!("{}Notification", M::TYPE_NAME).into()
    }

    fn schema_id() -> Cow<'static, str> {
        format!("piarc_protocol::NotificationMessage<{}>", M::NAME).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let members = vec![
            ("method", generator.subschema_for::<MethodName<M>>()),
            ("params", generator.subschema_for::<M::Params>()),
        ];
        message_schema(generator, format!("Notification `{}`.", M::NAME), members)
    }
}
