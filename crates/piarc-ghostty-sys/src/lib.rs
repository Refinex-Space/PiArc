//! piarc-ghostty-sys: libghostty-vt -sys layer: committed bindgen bindings, download and verification of official prebuilt artefacts (ADR-0017).
//!
//! # Responsibilities
//!
//! - The `-sys` layer for libghostty-vt: bindgen bindings committed to the repository, and download
//!   plus verification of the official prebuilt artefacts (ADR-0017).
//! - One of the two places where `unsafe` is allowed (the other is the NAPI boundary).
//!
//! # Not responsible for
//!
//! - Safe wrappers and terminal session logic (`piarc-term`).
//!
//! # Allowed workspace dependencies
//!
//! None. Only `piarc-term` may depend on this crate.
//!
//! The authoritative rules are in `crates/deps-rules.json`, enforced by
//! `scripts/ci/check-crate-deps.mjs` (architecture section 7.1).
