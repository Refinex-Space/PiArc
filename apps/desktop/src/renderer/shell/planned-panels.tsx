import { useT } from '../app/app-context.js';
import { FilesPanel } from '../files/FilesPanel.js';
import { GlobeIcon } from './icons.js';
import { PanelEmpty } from './PanelEmpty.js';
import { registerPanel } from './registry.js';
function PreviewPlaceholder() {
  const t = useT();
  return (
    <PanelEmpty
      testId="preview-placeholder"
      title={t('tiles.previewEmpty')}
      description={t('tiles.previewHint')}
      icon={<GlobeIcon />}
    />
  );
}
registerPanel({
  id: 'preview',
  area: 'tool',
  title: 'tiles.preview',
  order: 70,
  when: ({ sessionId }) => sessionId !== undefined,
  render: () => <PreviewPlaceholder />,
});
registerPanel({
  id: 'files',
  area: 'tool',
  title: 'tiles.files',
  order: 75,
  when: ({ sessionId }) => sessionId !== undefined,
  render: ({ sessionId }) => (sessionId ? <FilesPanel id={sessionId} /> : null),
});
