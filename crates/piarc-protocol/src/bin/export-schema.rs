//! Prints the exported protocol schema files as one JSON object keyed by file name.
//! Run by `npm run gen:protocol` (`scripts/dev/gen-protocol.mjs`), which writes the files.

use std::io::Write;

fn main() -> std::io::Result<()> {
    let files: serde_json::Map<String, serde_json::Value> = piarc_protocol::export_schema()
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect();
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &files)?;
    stdout.write_all(b"\n")
}
