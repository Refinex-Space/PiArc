# Changelog

All notable changes to PiArc are listed here, newest first. The format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). The Simplified Chinese edition is [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); both list the same versions.

Each version's entries are also the release notes shown in the app. How to write them: [docs/engineering/release.md](docs/engineering/release.md).

## [Unreleased]

## [1.0.0] - 2026-11-28

### Added

- First public release of PiArc, a desktop coding agent for macOS (Apple silicon and Intel) and Windows 11 (x64 and arm64), built on Pi.
- **Agent harness**: reads, edits and writes with read-before-write, conflict detection and encoding preserved; Bash and PowerShell with process-tree cleanup, timeouts and background tasks; subagents on any model; plan mode, task lists, questions and suggested next steps; automatic compaction with a live context gauge.
- **Models**: Anthropic, OpenAI, Gemini, DeepSeek, Kimi, Qwen, GLM, MiniMax, OpenRouter, any OpenAI- or Anthropic-compatible endpoint, and local models; sign-in with a subscription where the provider offers one; per-model settings, aliases and usage with estimated cost.
- **Extensibility**: skills, slash commands, output styles, plugins and Pi packages with a package market; MCP servers shared per workspace, with OAuth and on-demand tool loading.
- **Control and safety**: structured approvals with diff previews, saved rules and an audit trail; Auto review, where a reviewer model you choose answers routine approvals; rewind from pre-write snapshots per file and per hunk; a command sandbox with a network allowlist on macOS; credentials in an encrypted vault; managed settings for teams.
- **Workbench**: parallel sessions, each optionally in its own git worktree; a terminal powered by libghostty that the agent can read when you share it; a Git tool with staged hunks, generated commit messages, history, merges, rebases and GitHub pull requests through your own `gh`; a built-in browser the agent can drive behind approvals; a file browser, global search and a side chat.
- **Voice input**: offline dictation for Chinese, English and mixed technical speech.
- **Claude Code compatibility**: reads `CLAUDE.md` / `AGENTS.md`, permission rules, hooks, `.claude/agents`, skills, commands and `.mcp.json` as they are, never writes to `.claude/`, and imports Claude Code's auto memory.
- **About and updates**: a Settings → About page with the app and component versions; PiArc checks for new versions, downloads them through your proxy, verifies the signed release manifest and installs on restart, on macOS and Windows.
- English and Simplified Chinese, light and dark themes, keyboard-first and screen-reader friendly.
- A first-run guide that connects a model in a minute.

[Unreleased]: https://github.com/Refinex-Space/PiArc/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Refinex-Space/PiArc/releases/tag/v1.0.0
