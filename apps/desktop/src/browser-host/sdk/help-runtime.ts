// Ported from ego-browser package/ego-browser/src/help-runtime.ts (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: help() renders straight from public-api-schema.ts. Upstream also parsed the
// built bundle's JSDoc with acorn to document the frozen v1 helpers (`help("legacy", …)`); the v1
// surface is not ported, so that path, the JSDoc parser and the per-parameter docs are gone.

import { PUBLIC_API_SCHEMA, publicApiEntry, type PublicApiEntry } from './public-api-schema.js';

export interface HelperDoc {
  name: string;
  signature: string;
  description: string | null;
  async: boolean;
  public?: boolean;
}

export function help(...names: string[]): HelperDoc | HelperDoc[] | string {
  if (names.length === 0) {
    return PUBLIC_API_SCHEMA.map(publicEntryToHelpDoc);
  }
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    const publicEntry = findPublicEntry(only);
    if (publicEntry) return publicEntryToHelpDoc(publicEntry);
    return `Unknown helper: ${only}`;
  }
  return names.map((name) => {
    const publicEntry = findPublicEntry(name);
    if (publicEntry) return publicEntryToHelpDoc(publicEntry);
    return {
      name,
      signature: name,
      description: `Unknown helper: ${name}`,
      async: false,
    };
  });
}

export function formatHelp(doc: HelperDoc): string {
  const lines: string[] = [];
  if (doc.public) {
    lines.push(doc.name, '');
  }
  if (doc.description) {
    lines.push(doc.description);
  }
  lines.push('');
  lines.push(doc.signature);
  return lines.join('\n');
}

function findPublicEntry(name: string): PublicApiEntry | undefined {
  const normalized = name.replace(/^task\./, 'TaskSpace.').replace(/^page\./, 'Page.');
  return publicApiEntry(normalized);
}

function publicEntryToHelpDoc(entry: PublicApiEntry): HelperDoc {
  const options = entry.options
    ? Object.entries(entry.options)
        .map(([name, specification]) => {
          const values = specification.values ? ` (${specification.values.join(' | ')})` : '';
          return `${name}${values}: ${specification.description}`;
        })
        .join(' ')
    : '';
  return {
    name: entry.name,
    signature: entry.signature,
    description: options ? `${entry.summary} Options: ${options}` : entry.summary,
    async: entry.signature.startsWith('await '),
    public: true,
  };
}
