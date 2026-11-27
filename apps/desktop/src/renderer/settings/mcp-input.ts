// The add-server form's text fields, read into the parts `mcpAddServer` takes: the command line
// split like a shell would (quotes, backslash escapes; no expansion), the environment as one
// `NAME=value` per line. The main process and Core check the result again.

/** Splits a command line into words; `undefined` for an unclosed quote. */
export function splitCommand(text: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text.charAt(++i);
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text.charAt(++i);
      started = true;
    } else if (/\s/u.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote !== null) return undefined;
  if (started) words.push(word);
  return words;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** Server names as Core accepts them (`piarc_config::mcp::valid_name`). */
export function validServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(name) && !name.includes('__');
}

/** An `http(s)://` address without spaces. */
export function validServerUrl(url: string): boolean {
  return /^https?:\/\/\S+$/u.test(url);
}

/** One environment variable of the form. */
export interface EnvRow {
  readonly name: string;
  readonly value: string;
}

/** The rows as an environment: blank rows are skipped; `undefined` for a bad or repeated name. */
export function envFromRows(rows: readonly EnvRow[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '' && row.value.trim() === '') continue;
    if (!ENV_NAME.test(name) || Object.hasOwn(env, name)) return undefined;
    env[name] = row.value.trim();
  }
  return env;
}
