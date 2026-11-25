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
import { AppStore } from '../store/app-store.js';
import { StoreContext } from '../store/hooks.js';
import { composerSchema } from '../composer/schema.js';
import type { EditorDraft } from '../composer/session-draft.js';
import { NoticeBar } from '../shell/NoticeBar.js';
import { UsageRing } from '../shell/ContextUsage.js';

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

/** The usage ring's three levels, each on its own session. */
const RINGS = [
  ['ring-normal', 42],
  ['ring-warning', 81],
  ['ring-critical', 94],
] as const;

/** The input section's store: two notices and the rings' usage. */
function inputStore(): AppStore {
  const store = new AppStore();
  store.addLocalNotice({
    key: 'gitBashMissing',
    type: 'gitBashMissing',
    message: '',
    downloadUrl: undefined,
  });
  store.addLocalNotice({
    key: 'hook:lint',
    type: 'hook',
    message: 'Lint passed with 2 warnings in src/parser/blocks.ts.',
    downloadUrl: undefined,
    hook: { event: 'PostToolUse', error: false },
  });
  for (const [id, percent] of RINGS) {
    const contextWindow = 200_000;
    const tokens = (contextWindow * percent) / 100;
    store.transcript(id).usage.apply('session/usage', {
      usage: {
        tokens,
        contextWindow,
        autoCompactThreshold: 182_000,
        autoCompact: 'on',
        source: 'estimate',
        categories: {
          systemPrompt: 1_000,
          tools: 5_000,
          mcpTools: 0,
          memory: 0,
          skills: 0,
          conversation: tokens - 6_000,
          toolResults: 0,
          unclassified: 0,
        },
      },
    });
  }
  return store;
}

/** A draft with a mention and two attachments waiting to be sent. */
function inputDraft(): EditorDraft {
  const { nodes } = composerSchema;
  return {
    doc: nodes.doc.create(null, [
      nodes.paragraph.create(null, [
        nodes.command.create({
          name: 'review',
          kind: 'command',
          description: 'Review the working tree against the plan',
        }),
        composerSchema.text(' Compare '),
        nodes.mention.create({
          id: 'file:src/parser/blocks.ts',
          label: 'blocks.ts',
          path: 'src/parser/blocks.ts',
        }),
        composerSchema.text(' with the layouts, then '),
        nodes.command.create({
          name: 'release-notes',
          kind: 'skill',
          description: 'Draft release notes from merged changes',
        }),
      ]),
    ]),
    files: [
      {
        id: 'a1',
        file: new Blob([''], { type: 'image/png' }),
        name: 'layout-before.png',
        mimeType: 'image/png',
        size: 184_320,
        kind: 'image',
      },
      {
        id: 'a2',
        file: new Blob([''], { type: 'application/pdf' }),
        name: 'Release checklist with a long name.pdf',
        mimeType: 'application/pdf',
        size: 1_240_000,
        kind: 'pdf',
      },
    ],
  };
}

function sectionOf(hash: string): string {
  const query = hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('section') ?? 'conversation';
}

export function SessionGallery() {
  const [services] = useState(() => createTranscriptServices(null));
  const section = useMemo(() => gallerySection(sectionOf(window.location.hash)), []);
  const [store] = useState(() => (section.input === true ? inputStore() : new AppStore()));
  const [draft] = useState(() => (section.input === true ? inputDraft() : undefined));
  const [transcript] = useState(() => {
    const created = new SessionTranscript();
    created.apply(section.notifications);
    if (section.approvals !== undefined) created.setApprovals(section.approvals);
    if (section.undelivered !== undefined) {
      created.addOptimistic('gallery-1', {
        text: section.undelivered.text,
        mentions: [],
        attachments: [],
      });
      created.markUndelivered('gallery-1', section.undelivered.reason);
    }
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
        prompt: () => undefined,
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
    <StoreContext.Provider value={store}>
      <div className="session-gallery" data-testid="session-gallery">
        <main className="main">
          <section className="conversation" data-testid="conversation">
            <TranscriptContext.Provider value={view}>
              <div className="conversation-body">
                <Transcript />
              </div>
            </TranscriptContext.Provider>
            <div className="conversation-composer">
              {section.input === true ? <NoticeBar /> : null}
              <Composer
                running={section.running === true}
                savedDraft={draft}
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
                {section.input === true
                  ? RINGS.map(([id]) => <UsageRing key={id} sessionId={id} />)
                  : null}
              </div>
            </div>
          </section>
        </main>
        <TooltipLayer />
      </div>
    </StoreContext.Provider>
  );
}
