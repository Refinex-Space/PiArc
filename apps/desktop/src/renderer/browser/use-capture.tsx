// B3 of the preview panel in one place (design addendum 3.3): the element picker and its tray,
// annotation of a frozen page, the screenshot menu and its result, and the hand-off of all of it
// to the session's input. Picks come only from the main process (`browserPick` events: a real
// click while the picker is on, or the page menu); the page itself has no way to add one.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  BROWSER_CONTEXT_LIMITS,
  type BrowserImage,
  type BrowserRequest,
  type BrowserSessionState,
  type BrowserTabState,
} from '../../shared/browser.js';
import { useT } from '../app/app-context.js';
import { attachBrowserContext, type BrowserContextDraft } from '../composer/browser-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { openProjectFile, projectFileRoot } from '../files/navigation.js';
import { MenuPopup, useMenu, type MenuItem } from '../shell/Menu.js';
import { showPanel } from '../shell/registry.js';
import { useUi } from '../shell/ui.js';
import { useSession } from '../store/hooks.js';
import { AnnotateSurface } from './AnnotateCanvas.js';
import { imageName } from './context-items.js';
import { attachableBlob, cropImage, dataUrlBytes, extensionOf } from './images.js';
import {
  addPick,
  clearPicks,
  picksOf,
  removePick,
  setPickComment,
  usePicks,
  type TrayCard,
} from './picks.js';
import { onPreviewCommand, scopeSource, trayItems } from './preview-commands.js';
import { PickTray } from './PickTray.js';
import { SHOT_LABELS, ShotBar, type ShotKind } from './ShotBar.js';

function isImage(value: unknown): value is BrowserImage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof value.data === 'string' &&
    value.data.startsWith('data:image/png;base64,') &&
    'width' in value &&
    typeof value.width === 'number' &&
    'height' in value &&
    typeof value.height === 'number'
  );
}

export interface Capture {
  /** The picker is collecting cards in the shown tab. */
  readonly picking: boolean;
  readonly annotating: boolean;
  readonly pick: () => void;
  readonly annotate: () => void;
  readonly screenshot: (anchor: HTMLElement) => void;
  /** Drawn inside the viewport while annotating (the page's view is hidden). */
  readonly surface: ReactNode;
  /** The screenshot result and the tray, under the page. */
  readonly strips: ReactNode;
  readonly menu: ReactNode;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useCapture({
  sessionId,
  state,
  tab,
  call,
  report,
}: {
  readonly sessionId: string;
  readonly state: BrowserSessionState | undefined;
  readonly tab: BrowserTabState | undefined;
  readonly call: (request: BrowserRequest) => void;
  readonly report: (error: unknown) => void;
}): Capture {
  const t = useT();
  const ui = useUi();
  const session = useSession(sessionId);
  const cards = usePicks(sessionId);
  const shotMenu = useMenu();
  const [annotation, setAnnotation] = useState<{
    image: BrowserImage;
    mode: 'annotate' | 'region';
  }>();
  const [shot, setShot] = useState<{ image: BrowserImage; kind: ShotKind }>();
  const picking =
    state?.picking !== undefined && state.picking.tab === tab?.id ? state.picking.mode : undefined;
  const workspace = session?.workspace ?? '';
  const root = projectFileRoot(session);
  const url = tab?.url ?? '';

  const toast = useCallback(
    (text: string) => {
      ui.addToast({ sessionId, text });
    },
    [ui, sessionId],
  );

  // Picks from the main process: cards for the tray, or the element of the screenshot menu.
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type !== 'browserPick' || event.sessionId !== sessionId) return;
        const pick = scopeSource(event.pick, workspace, root);
        if (event.mode === 'shot') {
          if (pick.image === undefined) toast(t('browser.shot.noBox'));
          else setShot({ image: pick.image, kind: 'element' });
        } else if (!addPick(sessionId, pick)) {
          toast(t('browser.picks.full', { max: BROWSER_CONTEXT_LIMITS.picks }));
        }
      }),
    [sessionId, workspace, root, toast, t],
  );

  const handOff = useCallback(
    (draft: BrowserContextDraft) => {
      attachBrowserContext(sessionId, draft);
      showPanel('conversation');
    },
    [sessionId],
  );

  const capture = useCallback(
    async (kind: 'visible' | 'full'): Promise<BrowserImage | undefined> => {
      if (tab === undefined) return undefined;
      try {
        const value = await window.piarc.browser(sessionId, { op: 'capture', tab: tab.id, kind });
        return isImage(value) ? value : undefined;
      } catch (error) {
        report(error);
        return undefined;
      }
    },
    [sessionId, tab, report],
  );

  const pick = useCallback(() => {
    if (tab === undefined || annotation !== undefined) return;
    call({ op: 'pick', tab: tab.id, mode: picking === 'collect' ? 'off' : 'collect' });
  }, [tab, annotation, picking, call]);

  const annotate = useCallback(() => {
    if (tab === undefined || annotation !== undefined) return;
    if (picking !== undefined) call({ op: 'pick', tab: tab.id, mode: 'off' });
    void capture('visible').then((image) => {
      if (image !== undefined) setAnnotation({ image, mode: 'annotate' });
    });
  }, [tab, annotation, picking, call, capture]);

  // The workbench's Mod+Shift+S and Mod+Shift+X (and the command palette) arrive here.
  const commands = useRef({ pick, annotate });
  commands.current = { pick, annotate };
  useEffect(
    () =>
      onPreviewCommand(sessionId, (command) => {
        if (command === 'pick') commands.current.pick();
        else commands.current.annotate();
      }),
    [sessionId],
  );

  const addCards = async () => {
    const current = picksOf(sessionId);
    if (current.length === 0) return;
    const images: { blob: Blob; name: string }[] = [];
    for (const [index, card] of current.entries()) {
      if (card.pick.image === undefined) continue;
      const blob = await attachableBlob(card.pick.image);
      images.push({ blob, name: imageName('element', index + 1, extensionOf(blob)) });
    }
    handOff({ url: current[0]?.pick.context.url ?? url, items: trayItems(current), images });
    clearPicks(sessionId);
    if (picking !== undefined && tab !== undefined) call({ op: 'pick', tab: tab.id, mode: 'off' });
  };

  const addImage = async (
    image: BrowserImage,
    kind: string,
    items: BrowserContextDraft['items'],
  ) => {
    const blob = await attachableBlob(image);
    handOff({ url, items, images: [{ blob, name: imageName(kind, 1, extensionOf(blob)) }] });
  };

  const screenshot = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    shotMenu.openAt(rect.left, rect.bottom + 4, anchor);
  };
  const shotItems: MenuItem[] = [
    {
      id: 'visible',
      label: t(SHOT_LABELS.visible),
      testId: 'browser-shot-visible',
      run: () => {
        void capture('visible').then((image) => {
          if (image !== undefined) setShot({ image, kind: 'visible' });
        });
      },
    },
    {
      id: 'full',
      label: t(SHOT_LABELS.full),
      testId: 'browser-shot-full',
      run: () => {
        void capture('full').then((image) => {
          if (image !== undefined) setShot({ image, kind: 'full' });
        });
      },
    },
    {
      id: 'region',
      label: t(SHOT_LABELS.region),
      testId: 'browser-shot-region',
      run: () => {
        void capture('visible').then((image) => {
          if (image !== undefined) setAnnotation({ image, mode: 'region' });
        });
      },
    },
    {
      id: 'element',
      label: t(SHOT_LABELS.element),
      testId: 'browser-shot-element',
      run: () => {
        if (tab !== undefined) call({ op: 'pick', tab: tab.id, mode: 'shot' });
      },
    },
  ];

  const openSource = (card: TrayCard) => {
    const source = card.pick.context.source;
    if (source === undefined) return;
    openProjectFile(sessionId, {
      path: source.path,
      ...(source.line === undefined ? {} : { line: source.line }),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || isImeComposing(event.nativeEvent)) return;
    if (event.key === 'Escape' && picking !== undefined && tab !== undefined) {
      event.preventDefault();
      call({ op: 'pick', tab: tab.id, mode: 'off' });
    }
  };

  const surface =
    annotation === undefined ? null : (
      <AnnotateSurface
        image={annotation.image}
        mode={annotation.mode}
        onClose={() => {
          setAnnotation(undefined);
        }}
        onRegion={(rect) => {
          const source = annotation.image;
          setAnnotation(undefined);
          void cropImage(source, rect)
            .then((image) => {
              setShot({ image, kind: 'region' });
            })
            .catch(report);
        }}
        onAdd={(image, items) => {
          void addImage(image, 'annotation', items)
            .then(() => {
              setAnnotation(undefined);
            })
            .catch(report);
        }}
      />
    );

  const strips = (
    <>
      {shot !== undefined && (
        <ShotBar
          image={shot.image}
          kind={shot.kind}
          onCopy={() => {
            void window.piarc
              .browser(sessionId, { op: 'copyImage', image: shot.image.data })
              .then(() => {
                toast(t('browser.shot.copied'));
              })
              .catch(report);
          }}
          onSave={() => {
            void window.piarc
              .saveImage({
                kind: 'png',
                name: 'screenshot.png',
                bytes: dataUrlBytes(shot.image.data),
              })
              .catch(report);
          }}
          onAdd={() => {
            const image = shot.image;
            setShot(undefined);
            void addImage(image, 'screenshot', []).catch(report);
          }}
          onClose={() => {
            setShot(undefined);
          }}
        />
      )}
      {(cards.length > 0 || picking === 'collect') && (
        <PickTray
          cards={cards}
          picking={picking === 'collect'}
          onComment={(id, comment) => {
            setPickComment(sessionId, id, comment);
          }}
          onRemove={(id) => {
            removePick(sessionId, id);
          }}
          onClear={() => {
            clearPicks(sessionId);
          }}
          onDone={() => {
            if (tab !== undefined) call({ op: 'pick', tab: tab.id, mode: 'off' });
          }}
          onAdd={() => {
            void addCards().catch(report);
          }}
          onOpenSource={openSource}
          onCopySelector={(card) => {
            void navigator.clipboard
              .writeText(card.pick.context.selector)
              .then(() => {
                toast(t('browser.picks.copied'));
              })
              .catch(report);
          }}
        />
      )}
    </>
  );

  const menu =
    shotMenu.open === null ? null : (
      <MenuPopup
        at={shotMenu.open}
        items={shotItems}
        label={t('browser.screenshot')}
        testId="browser-shot-menu"
        onClose={shotMenu.close}
      />
    );

  return {
    picking: picking === 'collect',
    annotating: annotation !== undefined,
    pick,
    annotate,
    screenshot,
    surface,
    strips,
    menu,
    onKeyDown,
  };
}
