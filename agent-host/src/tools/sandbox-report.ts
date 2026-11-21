// What a command's result says about PiArc's sandbox (T39, architecture section 6.10): Core
// reports, for a command that ran sandboxed, what the sandbox refused (`ExecRunResult.sandbox`)
// and whether the sandbox itself failed to start; this turns it into the note after the
// command's output, so the model knows why a command failed and that it may ask to run it
// outside the sandbox (`dangerouslyDisableSandbox`, which the user always approves).
import type { SandboxDenial, SandboxDenialKind, SandboxReport } from '@piarc/protocol';

const KINDS: readonly SandboxDenialKind[] = ['read', 'write', 'network'];

/** `ExecRunResult.sandbox`, validated; undefined when absent or malformed. */
export function parseSandboxReport(value: unknown): SandboxReport | undefined {
  if (!isRecord(value)) return undefined;
  const denials: SandboxDenial[] = [];
  if (Array.isArray(value.denials)) {
    for (const entry of value.denials) {
      if (!isRecord(entry) || typeof entry.target !== 'string') return undefined;
      const kind = KINDS.find((k) => k === entry.kind);
      if (kind === undefined) return undefined;
      denials.push({ kind, target: entry.target });
    }
  }
  return {
    ...(denials.length > 0 ? { denials } : {}),
    ...(value.failedToStart === true ? { failedToStart: true } : {}),
  };
}

const REFUSED: Record<SandboxDenialKind, string> = {
  read: 'reading',
  write: 'writing',
  network: 'connecting to',
};

/** The note about the sandbox for a command that failed in it; empty when it succeeded. */
export function sandboxNote(report: SandboxReport | undefined, failed: boolean): string {
  if (report === undefined || !failed) return '';
  if (report.failedToStart === true) {
    return (
      'PiArc could not start its sandbox, so this command did not run. Commands now run ' +
      'without the sandbox and each one needs the user to approve it; run the command again.'
    );
  }
  const retry =
    'If the command needs this, run it again with dangerouslyDisableSandbox: true; the user ' +
    'is asked to approve running it outside the sandbox.';
  const denials = report.denials ?? [];
  if (denials.length > 0) {
    const listed = denials.map((d) => `${REFUSED[d.kind]} ${d.target}`).join('; ');
    return `PiArc's sandbox refused ${listed}. ${retry}`;
  }
  return (
    "The command ran in PiArc's sandbox: it may write only in the workspace, the session's " +
    'temporary directory and added directories, and reaches the network only through an ' +
    'HTTP proxy that admits allowed domains (tools that ignore HTTP proxies, such as ssh, ' +
    `and UDP cannot connect). If the failure comes from the sandbox: ${retry}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
