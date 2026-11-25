// The session gallery (`#/session-gallery?section=<name>`, dev builds only): the production
// transcript rows, approval cards and composer in one state each, in the app's real theme,
// density and language. L4 evidence runs screenshot it; nothing in the product links to it.
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Catalog } from '../shell/model-catalog.js';
import type { PaletteCommand } from '../composer/command-plugin.js';
import { Composer, type ComposerHandlers, type MentionSource } from '../composer/Composer.js';
import { matchCandidates } from '../composer/mention-plugin.js';
import { MENTION_CANDIDATES } from './fixtures/mention-candidates.js';
import { ModelMenus } from '../shell/ModelMenus.js';
import { PermissionModeMenu } from '../shell/PermissionModeMenu.js';
import { QueueList } from '../shell/QueueList.js';
import { SessionTranscript } from '../store/transcript.js';
import {
  TranscriptContext,
  createTranscriptServices,
  type TranscriptView,
} from '../transcript/services.js';
import { Transcript } from '../transcript/Transcript.js';
import { gallerySection } from './fixtures/gallery.js';
import { TooltipLayer } from '../app/Tooltip.js';

const CATALOG: Catalog = {
  model: { provider: 'mock', id: 'balanced' },
  effort: 'medium',
  models: [
    {
      provider: 'mock',
      id: 'balanced',
      name: 'Balanced',
      contextWindow: 200_000,
      maxOutput: 32_000,
      efforts: ['low', 'medium', 'high'],
      promptCache: true,
      toolReliability: 'verified',
      vision: true,
    },
  ],
};

const HANDLERS: ComposerHandlers = {
  submit: () => false,
  stop: () => undefined,
  command: () => undefined,
  mentionOpened: () => undefined,
  mentionChosen: () => undefined,
};

const MENTIONS: MentionSource = {
  search: (query) => Promise.resolve(matchCandidates(MENTION_CANDIDATES, query)),
  cancel: () => undefined,
};

const COMMANDS: readonly PaletteCommand[] = [
  { name: 'compact', description: '', source: 'builtIn', kind: 'builtIn', argumentHint: '[focus]' },
  { name: 'model', description: '', source: 'builtIn', kind: 'builtIn' },
  { name: 'rewind', description: '', source: 'builtIn', kind: 'builtIn' },
  {
    name: 'review',
    description: 'Review the working tree against the plan',
    source: 'projectClaude',
    kind: 'command',
    argumentHint: '[scope]',
  },
  {
    name: 'release-notes',
    description: 'Draft release notes from merged changes',
    source: 'user',
    kind: 'skill',
  },
];

function sectionOf(hash: string): string {
  const query = hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('section') ?? 'conversation';
}

export function SessionGallery() {
  const [services] = useState(() => createTranscriptServices(null));
  const section = useMemo(() => gallerySection(sectionOf(window.location.hash)), []);
  const [transcript] = useState(() => {
    const created = new SessionTranscript();
    created.apply(section.notifications);
    if (section.approvals !== undefined) created.setApprovals(section.approvals);
    return created;
  });
  useEffect(() => services.driver.follow(transcript), [services, transcript]);
  const view = useMemo<TranscriptView>(
    () => ({
      services,
      transcript,
      actions: {
        retry: () => undefined,
        resend: () => undefined,
        rewind: () => undefined,
        branchFrom: () => undefined,
        openFile: () => undefined,
        stopSubagent: () => undefined,
        subagentTranscript: () => Promise.resolve('{"start":0,"total":0,"items":[]}'),
      },
    }),
    [services, transcript],
  );
  const modeButton = useRef<HTMLButtonElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const effortButton = useRef<HTMLButtonElement>(null);
  return (
    <div className="session-gallery" data-testid="session-gallery">
      <main className="main">
        <section className="conversation" data-testid="conversation">
          <TranscriptContext.Provider value={view}>
            <div className="conversation-body">
              <Transcript />
            </div>
          </TranscriptContext.Provider>
          <div className="conversation-composer">
            <Composer
              running={section.running === true}
              handlers={HANDLERS}
              mentions={MENTIONS}
              commands={COMMANDS}
              limits={undefined}
              above={
                section.queue === undefined ? null : (
                  <QueueList
                    items={section.queue}
                    onEdit={() => undefined}
                    onDelete={() => undefined}
                  />
                )
              }
            />
            <div className="environment-bar">
              <ModelMenus
                id="gallery"
                catalog={CATALOG}
                running={section.running === true}
                modelButton={modelButton}
                effortButton={effortButton}
                onChange={() => undefined}
                onError={() => undefined}
              />
              <PermissionModeMenu
                id="gallery"
                mode="default"
                buttonRef={modeButton}
                onError={() => undefined}
              />
            </div>
          </div>
        </section>
      </main>
      <TooltipLayer />
    </div>
  );
}
