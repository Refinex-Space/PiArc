#!/usr/bin/env node
// A placeholder C compiler and archiver for the macOS cross-check of Windows code
// (`cargo clippy --target x86_64-pc-windows-msvc`): macOS has no Windows SDK headers, so C
// dependencies such as tree-sitter cannot be compiled for MSVC there. Clippy does not link, so
// the build only needs the output files to exist. Never use it for a build that runs.
//
//   CC_x86_64_pc_windows_msvc=scripts/dev/c-placeholder.mjs \
//   AR_x86_64_pc_windows_msvc=scripts/dev/c-placeholder.mjs cargo clippy --target …
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
for (const [i, arg] of args.entries()) {
  const target = arg === '-o' ? args[i + 1] : /^-(?:out:|Fo)(.+)$/u.exec(arg)?.[1];
  if (target !== undefined) writeFileSync(target, '');
}
