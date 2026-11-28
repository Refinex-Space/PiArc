//! The JSON form of frames (samples and diagnostics): colors as `"#rrggbb"`, the palette as an
//! array of 256 of them.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::Rgb;

impl Serialize for Rgb {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&format_args!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b))
    }
}

impl<'de> Deserialize<'de> for Rgb {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = Cow::<str>::deserialize(deserializer)?;
        let hex = text
            .strip_prefix('#')
            .filter(|hex| hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| D::Error::custom("a color is \"#rrggbb\""))?;
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map_err(D::Error::custom);
        Ok(Self {
            r: channel(0)?,
            g: channel(2)?,
            b: channel(4)?,
        })
    }
}

impl JsonSchema for Rgb {
    fn schema_name() -> Cow<'static, str> {
        "TermRgb".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "An RGB color as \"#rrggbb\".",
            "type": "string",
            "pattern": "^#[0-9a-fA-F]{6}$"
        })
    }
}

/// The schema of the palette: exactly 256 colors.
pub(super) struct PaletteSchema;

impl JsonSchema for PaletteSchema {
    fn schema_name() -> Cow<'static, str> {
        "TermPalette".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let item = generator.subschema_for::<Rgb>();
        json_schema!({
            "description": "The 256-color palette.",
            "type": "array",
            "items": item,
            "minItems": 256,
            "maxItems": 256
        })
    }
}

/// `#[serde(with)]` for the palette: an array of 256 colors.
pub(super) mod palette {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    use super::Rgb;

    pub(crate) fn serialize<S: Serializer>(
        palette: &[Rgb; 256],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(palette.iter())
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Box<[Rgb; 256]>, D::Error> {
        let colors = Vec::<Rgb>::deserialize(deserializer)?;
        let len = colors.len();
        colors
            .into_boxed_slice()
            .try_into()
            .map_err(|_| D::Error::custom(format!("the palette has 256 colors, not {len}")))
    }
}
