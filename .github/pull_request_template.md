## Summary

<!-- What changed and why, in a sentence or two. Link the issue it closes. -->

## How it was tested

<!-- The commands you ran and what they showed; screenshots for visible changes. -->

## Checklist

- [ ] <!-- source-and-license --> Sources and licenses: code inspired by another project names its source (repository, path, version) and license; nothing is copied from `reference/claude-code` or `reference/OpenClaudeDesktop` (code, prompts or UI components, ADR-0006)
- [ ] <!-- dependency-review --> New dependencies are reviewed: purpose and alternatives stated, license on the allowlist, version pinned exactly (no `^`/`~` in npm; Cargo only in `[workspace.dependencies]`), and `npm run audit:deps` reports no unhandled high or critical issue. Tick it when nothing was added
- [ ] <!-- threat-map --> New or changed security countermeasures are mapped in `tests/security/threats.yaml` with tests named after the threat (`docs/engineering/testing.md` section 16). Tick it when no countermeasure is involved
- [ ] `npm run verify` passes
