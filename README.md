# PiArc

**English** · [简体中文](README.zh-CN.md)

A professional AI coding agent workbench for macOS and Windows, built on [Pi](https://github.com/earendil-works/pi).

PiArc aims to combine three things:

- **Harness depth on par with Claude Code**: tools with strict editing invariants, permission modes and rules, hooks, subagents, plan mode, task lists, context engineering, checkpoints and rewind, skills, MCP, and sandboxing.
- **Pi's multi-provider model layer**: Anthropic, OpenAI, Google, DeepSeek, Kimi, Qwen, GLM, OpenRouter, local models, and more, with the same harness behavior across providers.
- **One desktop app for macOS and Windows**: a single Electron + React codebase for the UI, with the agent control plane in a Rust core. Windows ships from the same code, at most one milestone behind macOS.

> **Status: design phase.** The requirements and architecture are defined; implementation starts with the M0 technical spikes. There is no runnable code yet.

## Highlights (planned)

- Bring your existing Claude Code setup: `CLAUDE.md` / `AGENTS.md`, permission rules, hooks, `.claude/agents`, skills, commands and `.mcp.json` are read as-is (PiArc never writes to `.claude/`).
- Use any model for any job, for example run read-only exploration subagents on a fast, cheap model while the main session uses a stronger one.
- Structured approvals with diff previews, per-session and persistent rules, and an audit trail.
- Deterministic rewind backed by pre-write file snapshots, with per-file and per-hunk discard.
- Parallel sessions with optional git worktree isolation; MCP servers are shared per workspace instead of being duplicated per session.
- A built-in terminal powered by libghostty, whose screen the agent can also read for background tasks.
- Performance budgets (startup, memory, streaming frame time) enforced in CI on both platforms.

## Architecture at a glance

```
PiArc (Electron)
├── Renderer: React + TypeScript (UI, transcript, composer, terminal view), sandboxed
├── Main process: TypeScript (windows, menus, notifications, updates, event relay)
└── PiArc Core: Rust native module (via NAPI-RS), loaded in the main process
      policy & approvals · hooks · tool I/O · snapshots · sandbox · config · credentials · index · diff · terminal
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
apps/desktop/     Electron app: main process, preload, React renderer (planned)
crates/           Rust workspace for PiArc Core, incl. the NAPI-RS binding (planned)
agent-host/       TypeScript Agent Host and Harness Kit on the Pi SDK (planned)
packages/         Shared TypeScript packages, e.g. generated protocol types (planned)
design/tokens/    Design tokens, generated into CSS variables (planned)
docs/             Architecture, ADRs, requirements, research
reference/        Local read-only clones of reference repositories (git-ignored)
```

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | Technical spikes on both platforms: Rust Core in Electron via NAPI-RS, streaming transcript, multi-session Agent Host, credentials, signing and packaging, libghostty terminal, sandbox, Electron security baseline |
| M1 | Walking skeleton: sessions, streaming, core tools via Rust Core, basic approvals, model settings |
| M2 | Harness core: permission rules, plan mode, task list, hooks, checkpoints and rewind, compaction, Changes panel |
| M3 | Parallel sessions, subagents, background tasks, terminal, worktrees, MCP, skills and commands |
| M4 | Sandbox, plugins, accessibility, localization, performance budgets in CI |
| M5 | Beta on macOS and Windows: auto-review mode, auto memory, managed settings, release pipeline |

Each milestone is reached on macOS first; Windows meets the same exit criteria no later than the end of the next milestone.

## Unsigned builds

PiArc is free and open source, and releases will ship without platform code signing or notarization ([ADR-0018](docs/adr/0018-unsigned-distribution.md)). Expect to approve the app yourself the first time:

- **macOS**: move PiArc to Applications, open it once, then go to System Settings → Privacy & Security and choose **Open Anyway**. If the button does not appear, run `xattr -dr com.apple.quarantine /Applications/PiArc.app`; this skips macOS's origin check for PiArc only. New versions are announced inside the app and installed manually, and macOS may ask you to allow keychain access again after an update.
- **Windows**: when SmartScreen appears, choose **More info → Run anyway**. Updates install automatically. PCs with Smart App Control turned on block unsigned apps.

Each release publishes a manifest of SHA-256 checksums signed with the project's own key; the app checks it before updating.

## Compliance

PiArc is an independent project. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

- PiArc does **not** offer Claude.ai subscription login. Anthropic models are used with an API key, a cloud provider (Amazon Bedrock, Google Vertex AI, Microsoft Foundry) or your own gateway.
- PiArc is written clean-room: reference projects are studied for behavior only; no proprietary code, prompts or brand assets are copied. See [ADR-0006](docs/adr/0006-compliance-and-clean-room.md).

## Contributing

The project is at an early stage. Before proposing changes, read the [architecture document](docs/architecture/ARCHITECTURE.md); decisions in its chapter 4 can only be changed through a new ADR. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE)

PiArc builds on [Pi](https://github.com/earendil-works/pi) (MIT) by Mario Zechner and contributors.
