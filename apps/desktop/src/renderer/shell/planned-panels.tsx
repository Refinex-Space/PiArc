import { FilesPanel } from '../files/FilesPanel.js';
import '../browser/panels.js';
import { registerPanel } from './registry.js';
registerPanel({
  id: 'files',
  area: 'tool',
  title: 'tiles.files',
  order: 75,
  when: ({ sessionId }) => sessionId !== undefined,
  render: ({ sessionId }) => (sessionId ? <FilesPanel id={sessionId} /> : null),
});
