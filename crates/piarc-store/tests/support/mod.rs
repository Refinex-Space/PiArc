//! Session-file fixtures in Pi 1.5.2's format (`session-manager.ts`) and temporary
//! directories with spaces and Chinese characters in their path.

#![allow(
    dead_code,
    reason = "each test binary uses a different part of the support module"
)]

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// A temporary directory removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("piarc-store {name} 中文 {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Deterministic pseudo-random numbers (xorshift64*), so failures reproduce.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

pub fn iso(ms: i64) -> String {
    // Seconds since the epoch to a UTC date (inverse of the store's parser; tests only use
    // dates in 2026).
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Writes the lines of one Pi session.
pub struct SessionWriter {
    pub path: PathBuf,
    pub id: String,
    next: u64,
    last: Option<String>,
    clock: i64,
}

pub const START_MS: i64 = 1_794_800_000_000;

impl SessionWriter {
    /// Creates `<sessions>/--<cwd>--/<ts>_<id>.jsonl` with its header.
    pub fn create(sessions: &Path, cwd: &str, id: &str, version: Option<u32>) -> Self {
        let dir = sessions.join(format!(
            "--{}--",
            cwd.trim_start_matches('/').replace(['/', '\\', ':'], "-")
        ));
        std::fs::create_dir_all(&dir).expect("session dir");
        let path = dir.join(format!("2026-11-16T10-00-00-000Z_{id}.jsonl"));
        let mut writer = Self {
            path,
            id: id.to_owned(),
            next: 0,
            last: None,
            clock: START_MS,
        };
        let version = version.map_or(String::new(), |v| format!(r#""version":{v},"#));
        writer.append_raw(&format!(
            r#"{{"type":"session",{version}"id":"{id}","timestamp":"{}","cwd":"{cwd}"}}"#,
            iso(START_MS)
        ));
        writer
    }

    fn header(&mut self, kind: &str) -> String {
        self.next += 1;
        self.clock += 1500;
        let id = format!("e{:06}", self.next);
        let parent = self
            .last
            .as_ref()
            .map_or("null".to_owned(), |p| format!("\"{p}\""));
        self.last = Some(id.clone());
        format!(
            r#""type":"{kind}","id":"{id}","parentId":{parent},"timestamp":"{}""#,
            iso(self.clock)
        )
    }

    pub fn append_raw(&mut self, line: &str) {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .expect("open session file");
        file.write_all(line.as_bytes()).expect("write");
        file.write_all(b"\n").expect("write");
    }

    /// Appends bytes without a newline (a write Pi has not finished).
    pub fn append_partial(&mut self, bytes: &str) {
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .expect("open session file");
        file.write_all(bytes.as_bytes()).expect("write");
    }

    pub fn user(&mut self, text: &str) -> String {
        let head = self.header("message");
        format!(
            r#"{{{head},"message":{{"role":"user","content":[{{"type":"text","text":{}}}],"timestamp":{}}}}}"#,
            serde_json::to_string(text).expect("json"),
            self.clock
        )
    }

    pub fn assistant(&mut self, text: &str, model: &str, input: u64, output: u64) -> String {
        let head = self.header("message");
        format!(
            r#"{{{head},"message":{{"role":"assistant","content":[{{"type":"text","text":{}}},{{"type":"toolCall","id":"t{}","name":"read","arguments":{{"path":"a b/中文.txt"}}}}],"api":"anthropic-messages","provider":"piarc-mock","model":"{model}","usage":{{"input":{input},"output":{output},"cacheRead":3,"cacheWrite":1,"totalTokens":{},"cost":{{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.125}}}},"stopReason":"toolUse","timestamp":{}}}}}"#,
            serde_json::to_string(text).expect("json"),
            self.next,
            input + output + 4,
            self.clock
        )
    }

    pub fn tool_result(&mut self, text: &str) -> String {
        let head = self.header("message");
        format!(
            r#"{{{head},"message":{{"role":"toolResult","toolCallId":"t","toolName":"read","content":[{{"type":"text","text":{}}},{{"type":"image","data":"iVBORw0KGgo=","mimeType":"image/png"}}],"isError":false,"timestamp":{}}}}}"#,
            serde_json::to_string(text).expect("json"),
            self.clock
        )
    }

    pub fn name(&mut self, name: &str) -> String {
        let head = self.header("session_info");
        format!(
            r#"{{{head},"name":{}}}"#,
            serde_json::to_string(name).expect("json")
        )
    }

    pub fn model_change(&mut self, model: &str) -> String {
        let head = self.header("model_change");
        format!(r#"{{{head},"provider":"piarc-mock","modelId":"{model}"}}"#)
    }

    /// One random entry.
    /// A custom entry (`piarc.*` records the Agent Host keeps in the file).
    pub fn custom(&mut self, custom_type: &str, data: &str) -> String {
        let head = self.header("custom");
        format!(r#"{{{head},"customType":"{custom_type}","data":{data}}}"#)
    }

    pub fn random_entry(&mut self, rng: &mut Rng) -> String {
        match rng.below(6) {
            0 => self.user(&format!("请修复 bug {} in \"a b\"", rng.below(1000))),
            1 | 2 => self.assistant(
                "done",
                if rng.below(2) == 0 {
                    "mock-large"
                } else {
                    "mock-small"
                },
                rng.below(5000),
                rng.below(900),
            ),
            3 => self.tool_result(&"line\n".repeat(usize::try_from(rng.below(40)).unwrap_or(1))),
            4 => self.name(&format!("会话 {}", rng.below(100))),
            _ => self.model_change("mock-large"),
        }
    }
}
