# PiArc

**English** · [简体中文](README.zh-CN.md)

A native, professional AI coding agent workbench built on [Pi](https://github.com/earendil-works/pi).

PiArc aims to combine three things:

- **Harness depth on par with Claude Code**: tools with strict editing invariants, permission modes and rules, hooks, subagents, plan mode, task lists, context engineering, checkpoints and rewind, skills, MCP, and sandboxing.
- **Pi's multi-provider model layer**: Anthropic, OpenAI, Google, DeepSeek, Kimi, Qwen, GLM, OpenRouter, local models, and more, with the same harness behavior across providers.
- **A truly native desktop app**: SwiftUI + AppKit on macOS first, a native Windows client later. No Electron, no web UI shell.

> **Status: design phase.** The requirements and architecture are defined; implementation starts with the M0 technical spikes. There is no runnable code yet.

## Highlights (planned)

- Bring your existing Claude Code setup: `CLAUDE.md` / `AGENTS.md`, permission rules, hooks, `.claude/agents`, skills, commands and `.mcp.json` are read as-is (PiArc never writes to `.claude/`).
- Use any model for any job, for example run read-only exploration subagents on a fast, cheap model while the main session uses a stronger one.
- Structured approvals with diff previews, per-session and persistent rules, and an audit trail.
- Deterministic rewind backed by pre-write file snapshots, with per-file and per-hunk discard.
- Parallel sessions with optional git worktree isolation; MCP servers are shared per workspace instead of being duplicated per session.
- Performance budgets (startup, memory, streaming frame time) enforced in CI.

## Architecture at a glance

```
PiArc.app (one process)
├── Client: Swift 6, SwiftUI shell + AppKit/TextKit 2 for transcript, diff, terminal
└── PiArc Core: Rust static library (via UniFFI)
      policy & approvals · hooks · tool I/O · snapshots · sandbox · config · keychain · index · rendering
          │  AHP: versioned JSON-RPC over stdio
          ▼
Agent Host (one Node process per workspace)
└── Pi SDK + Harness Kit (PiArc's Pi extensions)
      agent loop · model providers · context assembly · compaction · subagents · plan · todo
```

Read more:

- [Architecture design](docs/architecture/ARCHITECTURE.md) (Chinese)
- [Requirements](docs/product/REQUIREMENTS.md) (Chinese)
- [Architecture decision records](docs/adr/README.md) (Chinese)
- [Research notes and reference sources](docs/research/) (Chinese)

## Repository layout

```
apps/macos/       macOS client (planned)
apps/windows/     Windows client (phase 2)
crates/           Rust workspace for PiArc Core (planned)
agent-host/       TypeScript Agent Host and Harness Kit on the Pi SDK (planned)
design/tokens/    Design tokens, single source for all platforms (planned)
docs/             Architecture, ADRs, requirements, research
reference/        Local read-only clones of reference repositories (git-ignored)
```

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | Technical spikes: native transcript rendering, UniFFI, multi-session Agent Host, keychain credentials, Node signing, terminal, sandbox |
| M1 | Walking skeleton: sessions, streaming, core tools via Rust Core, basic approvals, model settings |
| M2 | Harness core: permission rules, plan mode, task list, hooks, checkpoints and rewind, compaction, Changes panel |
| M3 | Parallel sessions, subagents, background tasks, terminal, worktrees, MCP, skills and commands |
| M4 | Sandbox, plugins, accessibility, localization, performance budgets in CI |
| M5 | Beta: auto-review mode, auto memory, managed settings, release pipeline |
| W0–W3 | Native Windows client on the same Core |

## Compliance

PiArc is an independent project. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

- PiArc does **not** offer Claude.ai subscription login. Anthropic models are used with an API key, a cloud provider (Amazon Bedrock, Google Vertex AI, Microsoft Foundry) or your own gateway.
- PiArc is written clean-room: reference projects are studied for behavior only; no proprietary code, prompts or brand assets are copied. See [ADR-0006](docs/adr/0006-compliance-and-clean-room.md).

## Contributing

The project is at an early stage. Before proposing changes, read the [architecture document](docs/architecture/ARCHITECTURE.md); decisions in its chapter 4 can only be changed through a new ADR. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE)

PiArc builds on [Pi](https://github.com/earendil-works/pi) (MIT) by Mario Zechner and contributors.
