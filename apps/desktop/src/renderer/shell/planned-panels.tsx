// The reserved panes take part in layout without advertising an active browser or file service.
import { useT } from '../app/app-context.js';
import { FolderIcon, GlobeIcon } from './icons.js';
import { PanelEmpty } from './PanelEmpty.js';
import { registerPanel } from './registry.js';

function PlannedPanel({ kind }: { kind: 'files' | 'preview' }) {
  const t = useT();
  return (
    <PanelEmpty
      testId={kind + '-placeholder'}
      title={t(kind === 'files' ? 'tiles.filesEmpty' : 'tiles.previewEmpty')}
      description={t(kind === 'files' ? 'tiles.filesHint' : 'tiles.previewHint')}
      icon={kind === 'files' ? <FolderIcon /> : <GlobeIcon />}
    />
  );
}
for (const kind of ['files', 'preview'] as const) {
  registerPanel({
    id: kind,
    area: 'tool',
    title: kind === 'files' ? 'tiles.files' : 'tiles.preview',
    order: kind === 'files' ? 75 : 70,
    when: ({ sessionId }) => sessionId !== undefined,
    render: () => <PlannedPanel kind={kind} />,
  });
}
