// Registers the preview tool (ADR-0075 tile, ADR-0088 browser).
import { registerPanel } from '../shell/registry.js';
import { BrowserPanel } from './BrowserPanel.js';

registerPanel({
  id: 'preview',
  area: 'tool',
  title: 'tiles.preview',
  order: 70,
  when: ({ sessionId }) => sessionId !== undefined,
  render: ({ sessionId }) => (sessionId ? <BrowserPanel sessionId={sessionId} /> : null),
});
