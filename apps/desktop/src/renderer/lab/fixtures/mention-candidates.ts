// A fixed candidate list for the `@` picker; T19 replaces it with Core's fuzzy file search.
import type { MentionData } from '../../composer/schema.js';

export const MENTION_CANDIDATES: readonly MentionData[] = [
  { id: 'readme', label: 'README.md', path: 'README.md' },
  { id: 'architecture', label: 'ARCHITECTURE.md', path: 'docs/architecture/ARCHITECTURE.md' },
  { id: 'main', label: 'main.ts', path: 'apps/desktop/src/main/main.ts' },
  {
    id: 'transcript',
    label: 'Transcript.tsx',
    path: 'apps/desktop/src/renderer/transcript/Transcript.tsx',
  },
  {
    id: 'composer',
    label: 'Composer.tsx',
    path: 'apps/desktop/src/renderer/composer/Composer.tsx',
  },
  { id: 'cargo', label: 'Cargo.toml', path: 'Cargo.toml' },
];
