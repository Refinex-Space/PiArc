# Contributing to PiArc

Thanks for your interest in PiArc. Bug reports, ideas, documentation fixes and code are all welcome. This guide explains how to propose a change and what a pull request needs before it can be merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues are not reported here: see [SECURITY.md](SECURITY.md).

## Ways to contribute

- **Report a bug.** Open an [issue](https://github.com/Refinex-Space/PiArc/issues/new/choose) with your PiArc version, operating system, the model provider you used and the steps that reproduce it. A diagnostic bundle (**Settings → Configuration diagnostics → Diagnostic bundle**) helps; PiArc leaves out credentials and session content, but read it before you attach it.
- **Suggest a feature.** Describe the problem first, then the change you have in mind. Larger ideas are easier to discuss before anyone writes code.
- **Improve the docs.** Fixes to the README, the guides in `docs/` and the per-directory `AGENTS.md` files are always useful.
- **Send a pull request.** For anything beyond a small fix, open an issue first so we can agree on the approach.

## Before you write code

PiArc has a written design baseline, [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md), and records every decision that changes it as an ADR in [`docs/adr/`](docs/adr/README.md). A change that fits the baseline can go straight to a pull request. A change that would alter it (a new process boundary, a different storage format, a new dependency direction between crates) starts with an ADR whose status is *Proposed*. Larger features get a design addendum in `docs/architecture/addenda/`.

A few rules hold across the whole codebase:

- **Clean room.** PiArc studies other agents for behavior only. Do not copy code, prompts or UI components from Claude Code, Claude Desktop or any project whose license does not allow it, and do not use Anthropic brand assets ([ADR-0006](docs/adr/0006-compliance-and-clean-room.md)). Name the source and license of anything you adapt from an open-source project.
- **Credentials stay in Core.** Keys and tokens live only in Core's vault and reach the Agent Host only over its protocol: never in environment variables, config files, logs or error messages ([ADR-0021](docs/adr/0021-credential-vault-and-pi-adapter.md)).
- **The Agent Host never touches the file system or processes.** Tools ask Core, which applies permissions, snapshots and hooks.
- **Dependencies are pinned exactly.** No `^` or `~` in npm; Rust dependencies are declared once in `[workspace.dependencies]`. Licenses must be on the allowlist in `deny.toml`.

## Development setup

The [README](README.md#build-from-source) lists the prerequisites and the commands to build and run PiArc from source. In short:

```bash
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run build:core
npm run build:agent-host
npm run start -w @piarc/desktop
```

Every command in [AGENTS.md](AGENTS.md) has been run from the repository root. Each directory with its own conventions has an `AGENTS.md` (shared by human contributors and coding agents; the `CLAUDE.md` next to it only imports it). Read the one for the directory you are changing.

### Repository layout

| Path | What lives there |
|---|---|
| `apps/desktop/` | The Electron app: main process, preload and the React renderer |
| `crates/` | The Rust workspace: PiArc Core, its feature crates and the NAPI-RS binding |
| `agent-host/` | The Agent Host and Harness Kit on the Pi SDK |
| `packages/` | Generated protocol types and test-only helpers |
| `design/` | Design tokens and brand assets |
| `tests/` | L2 scenarios, contract samples, the capability list and the threat map |
| `scripts/` | Cross-platform Node scripts for development, CI and releases |
| `docs/` | Architecture, ADRs, requirements, engineering guidelines |

## Making a change

### Code style

- **TypeScript**: strict mode, no `any`, validate every value that crosses a boundary (IPC, protocol, files, network) before using it. See [`docs/engineering/coding-standards.md`](docs/engineering/coding-standards.md).
- **Rust**: `thiserror` errors with a kind, no `unwrap()` outside tests, `unsafe` only in the modules listed in the coding standards, each block with a `// SAFETY:` comment.
- **UI**: colors, sizes and spacing come only from design tokens; every visible string goes into both language catalogs (`apps/desktop/src/shared/i18n/en.ts` and `zh-CN.ts`); follow the [visual design](docs/engineering/visual-design.md) and [accessibility](docs/engineering/accessibility.md) guidelines.
- **Language**: code, comments, commit messages and these community documents are in English. Design documents in `docs/` are in Chinese.
- Format with `npm run format` (Prettier) and `cargo fmt`.

### Tests

Add or update tests with every behavior change, and write a failing test before fixing a bug.

| Layer | What it covers | Run it |
|---|---|---|
| Unit | Pure logic in TypeScript and Rust | `npx vitest run <path>`, `cargo test -p <crate>` |
| L1 | Protocol contracts between Core and the Agent Host | part of `npm run verify` |
| L2 | Scenarios that drive Core and a real Agent Host against a strict mock model | `cargo test -p piarc-testkit --test scenarios -- <id> --exact` |
| L4 | The packaged app, end to end, with Playwright | `npx playwright test -c apps/desktop/playwright.config.ts <spec> --project dev` |

Tests never call a real model provider: the model side is always the mock provider in `crates/piarc-testkit`. The full testing guide is [`docs/engineering/testing.md`](docs/engineering/testing.md).

Before you open a pull request, run the checks CI runs:

```bash
node scripts/dev/install-tools.mjs   # once
npm run verify
```

`verify` runs formatting, linting, type checks, unit tests, Rust tests, protocol drift, dependency rules, every L2 scenario, design tokens, i18n and the threat map, and prints a summary. L4 runs in CI on both platforms; for UI changes, run the relevant specs locally after `npm run package:desktop -- --flavor development`.

### Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(desktop): show providers' brand marks
fix(core): keep one endpoint id across a failed test and the retry
docs: describe the first-run guide
```

Keep each commit focused, and explain *why* in the body when it is not obvious.

### Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with tests, and update the docs it affects (the `AGENTS.md` of the directory, the architecture or an ADR when a decision changed).
3. Run `npm run verify`.
4. Open a pull request and fill in the template: what changed, how you tested it, and the checklist on sources, dependencies and security countermeasures.
5. A maintainer reviews it. CI must pass on macOS and Windows before it is merged.

## License

PiArc is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
