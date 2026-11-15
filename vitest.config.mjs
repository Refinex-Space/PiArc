import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.{ts,mts,mjs}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'target/**',
      'tmp/**',
      '.tools/**',
      'reference/**',
      'docs/**',
    ],
  },
});
