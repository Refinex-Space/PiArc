//! Runs the shared frame codec cases in `tests/contracts/framing/` against the Rust codec.
//! `packages/protocol/src/framing.test.ts` runs the same cases against the TypeScript one.

use std::collections::BTreeSet;
use std::path::Path;

use piarc_protocol::{DEFAULT_MAX_FRAME_BYTES, FrameDecoder, encode_frame};
use serde_json::{Value, json};

fn load(file: &str) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/contracts/framing")
        .join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text).expect("case file is JSON");
    doc["cases"].as_array().expect("cases array").clone()
}

fn bytes_of(input: &Value) -> Vec<u8> {
    if let Some(text) = input["utf8"].as_str() {
        return text.as_bytes().to_vec();
    }
    let hex = input["hex"].as_str().expect("input has utf8 or hex");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
        .collect()
}

#[test]
fn decoder_passes_the_shared_cases() {
    let cases = load("decode.json");
    let mut categories = BTreeSet::new();
    for case in &cases {
        let name = case["name"].as_str().expect("case name");
        categories.insert(case["category"].as_str().expect("category").to_owned());
        let max = case["maxFrameBytes"]
            .as_u64()
            .map_or(DEFAULT_MAX_FRAME_BYTES, |n| {
                usize::try_from(n).expect("fits usize")
            });
        let mut decoder = FrameDecoder::with_max_frame_bytes(max);
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let actual: Vec<Value> = decoder
                .decode(&bytes_of(&step["input"]))
                .into_iter()
                .map(|frame| match frame {
                    Ok(value) => json!({ "value": value }),
                    Err(error) => json!({ "error": error.kind() }),
                })
                .collect();
            assert_eq!(
                actual,
                step["expect"].as_array().expect("expect").clone(),
                "{name}, step {index}"
            );
        }
        println!("ok {name}");
    }
    for required in [
        "partial",
        "coalesced",
        "oversized",
        "invalidUtf8",
        "invalidJson",
        "lineSeparators",
    ] {
        assert!(categories.contains(required), "no {required} case");
    }
}

#[test]
fn encoder_passes_the_shared_cases() {
    for case in load("encode.json") {
        let name = case["name"].as_str().expect("case name");
        let frame = encode_frame(&case["value"]).expect("encodable");
        assert_eq!(frame, bytes_of(&case["expect"]), "{name}");
        assert_eq!(
            frame.iter().filter(|&&b| b == b'\n').count(),
            1,
            "{name}: one LF"
        );
        assert_eq!(frame.last(), Some(&b'\n'), "{name}: LF at the end");
        let decoded = FrameDecoder::new().decode(&frame);
        assert_eq!(decoded.len(), 1, "{name}");
        assert_eq!(decoded[0].as_ref().ok(), Some(&case["value"]), "{name}");
        println!("ok {name}");
    }
}
