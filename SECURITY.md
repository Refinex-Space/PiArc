# Security Policy

PiArc runs an AI agent that reads your code, edits files and runs commands on your computer, so we take security reports seriously. Thank you for helping keep PiArc and its users safe.

## Supported versions

Security fixes go into the latest release. Please update to it before you report, and check whether the issue still reproduces there.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |
| Unreleased `main` | Best effort |

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to [the private reporting form](https://github.com/Refinex-Space/PiArc/security/advisories/new). Only the maintainers can see the report.

A useful report includes:

- what an attacker can do, and what they need first (a malicious repository, a crafted model reply, a hostile web page, local access);
- the PiArc version, your operating system and architecture, and the model provider involved;
- the steps to reproduce, ideally with a minimal project or file;
- any proof-of-concept code, logs or screenshots. Remove your API keys and personal data first.

## What happens next

- We aim to acknowledge your report within **3 business days** and to send a first assessment within **10 business days**.
- We keep you informed while we work on a fix and may ask for more detail.
- When a fix is ready we publish a release and a GitHub security advisory, and request a CVE when it applies. We credit you in the advisory unless you prefer to stay anonymous.
- Please give us reasonable time to release the fix before you disclose the issue publicly. We are happy to agree on a disclosure date with you.

## Scope

In scope: the PiArc desktop app and its source in this repository, including

- bypasses of the permission system: tool calls, file access or commands that run without the approval the active mode and rules require;
- escapes from the macOS command sandbox or from the agent's working directory;
- a project running its hooks, MCP servers, allow rules or plugins before you trust it;
- credentials leaking out of the vault (into logs, files, environment variables, the Agent Host or a model request they do not belong to);
- script execution in the renderer, or a web page or model output that reaches the preload API;
- tampering with updates or the signed release manifest.

Out of scope:

- vulnerabilities in a model provider, an MCP server, a plugin or a Pi package you chose to install, unless PiArc makes them worse;
- actions you approved, or that your own rules, Auto review or bypass permissions allow;
- the absence of Apple or Microsoft code signing, which is a deliberate choice ([ADR-0018](docs/adr/0018-unsigned-distribution.md));
- attacks that already require full control of your user account;
- denial of service through a model's output volume or cost.

When you are unsure whether something is in scope, report it anyway.

## Security model

PiArc's threat model and the countermeasure for each threat are part of the [architecture](docs/architecture/ARCHITECTURE.md) (section 10). Every countermeasure is mapped to the tests that check it in [`tests/security/threats.yaml`](tests/security/threats.yaml); the generated [coverage table](docs/security/threat-coverage.md), the [Electron security checklist](docs/security/electron-checklist.md) and the list of [outbound connections](docs/security/egress.md) are in `docs/security/`.
