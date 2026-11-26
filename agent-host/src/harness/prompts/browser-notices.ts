// Notices about the built-in browser that Core pushes through `session/remind` (ADR-0092).
// PiArc's own text (ADR-0006); `scripts/dev/check-prompt-originality.mjs` checks it with the
// other prompts.

/**
 * `browserVerify` (ADR-0092 rule 6, `autoVerify`): the agent changed a front-end file a
 * running development server serves. Core's text is the server's address on the first line,
 * then the changed files, one per line.
 */
export function browserVerifyNotice(text: string): string {
  const [address = '', ...files] = text.split('\n').map((line) => line.trim());
  const changed = files.filter((file) => file !== '');
  const what = changed.length === 0 ? 'front-end files' : changed.join(', ');
  return [
    `You changed ${what}, which a development server running for this session serves` +
      (address === '' ? '.' : ` at ${address}.`),
    'Before you report the change as finished, load the page with the Browser tool and check ' +
      'that it renders and behaves as intended; read its console for errors. If the server ' +
      'reloads on its own, wait for the reload first. This note is not for the user.',
  ].join('\n');
}
