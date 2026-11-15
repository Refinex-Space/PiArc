//! L1 contract tests: every sample under `tests/contracts/<contract>/` must survive a serde
//! round trip unchanged (compared as JSON values), and every sample under `invalid/` must
//! fail to deserialize.

use std::fs;
use std::path::{Path, PathBuf};

use piarc_protocol::CONTRACTS;
use piarc_protocol::jsonrpc::Message;
use serde_json::Value;

fn contracts_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contracts")
}

fn contract_dir(name: &str) -> PathBuf {
    name.split('/')
        .fold(contracts_root(), |dir, part| dir.join(part))
}

/// The `*.json` files directly inside `dir`, sorted. A missing directory yields none.
fn samples(dir: &Path) -> Vec<(PathBuf, Value)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .map(|e| e.expect("readable directory entry").path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).expect("readable sample");
            let value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()));
            (path, value)
        })
        .collect()
}

#[test]
fn valid_samples_round_trip_unchanged() {
    let mut checked = 0;
    for contract in CONTRACTS {
        let dir = contract_dir(contract.name());
        let valid = samples(&dir);
        assert!(
            !valid.is_empty(),
            "contract {} has no valid sample in {}",
            contract.name(),
            dir.display()
        );
        for (path, sample) in valid {
            let back = contract
                .roundtrip(sample.clone())
                .unwrap_or_else(|e| panic!("{} was rejected: {e}", path.display()));
            assert_eq!(back, sample, "{} changed in the round trip", path.display());
            Message::from_value(sample)
                .unwrap_or_else(|e| panic!("{} is not a JSON-RPC message: {e}", path.display()));
            println!(
                "ok      {}",
                path.strip_prefix(contracts_root())
                    .unwrap_or(&path)
                    .display()
            );
            checked += 1;
        }
    }
    println!("{checked} valid samples round-tripped");
}

#[test]
fn invalid_samples_are_rejected() {
    let mut checked = 0;
    for contract in CONTRACTS {
        let dir = contract_dir(contract.name()).join("invalid");
        let invalid = samples(&dir);
        assert!(
            !invalid.is_empty(),
            "contract {} has no invalid sample in {}",
            contract.name(),
            dir.display()
        );
        for (path, sample) in invalid {
            let error = contract
                .roundtrip(sample)
                .expect_err(&format!("{} was accepted", path.display()));
            println!(
                "rejects {}: {error}",
                path.strip_prefix(contracts_root())
                    .unwrap_or(&path)
                    .display()
            );
            checked += 1;
        }
    }
    println!("{checked} invalid samples rejected");
}
