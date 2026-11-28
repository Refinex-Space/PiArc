// B3 of the preview panel in one place (design addendum 3.3): the element picker and its card
// in place on the frozen page, annotation of a frozen page, the screenshot menu and its result,
// and the hand-off of all of it to the session's input. Picks come only from the main process (`browserPick` events: a real
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
import { imageName, regionItem } from './context-items.js';
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
import { PickSurface, type PickStage } from './PickSurface.js';
import { onPreviewCommand, scopeSource, trayItems } from './preview-commands.js';
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
  /** The page is held still: annotating, or a picked element's card is open. */
  readonly frozen: boolean;
  /** Picked elements waiting to be added. */
  readonly pending: number;
  readonly pick: () => void;
  readonly annotate: () => void;
  readonly screenshot: (anchor: HTMLElement) => void;
  /** Drawn inside the viewport while the page is frozen (its view is hidden). */
  readonly surface: ReactNode;
  /** The screenshot result, under the page. */
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
  const [stage, setStage] = useState<PickStage>();
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
          return;
        }
        // The frame is shown once, beside the card; the tray keeps the rest.
        const { frame, ...card } = pick;
        if (!addPick(sessionId, card)) {
          toast(t('browser.picks.full', { max: BROWSER_CONTEXT_LIMITS.picks }));
        } else if (frame !== undefined) {
          setStage({
            frame: frame.image,
            focus: pick.id,
            outline: { id: pick.id, box: pick.context.box, scale: frame.scale },
          });
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
    setStage(undefined);
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

  // Picking ended with elements waiting: their card opens again on the page as it is now.
  const wasPicking = useRef(false);
  const held = useRef({ stage, annotation });
  held.current = { stage, annotation };
  useEffect(() => {
    const was = wasPicking.current;
    wasPicking.current = picking === 'collect';
    if (!was || picking === 'collect') return;
    if (held.current.stage !== undefined || held.current.annotation !== undefined) return;
    const last = picksOf(sessionId).at(-1);
    if (last === undefined) return;
    void capture('visible').then((image) => {
      if (image !== undefined)
        setStage((current) => current ?? { frame: image, focus: last.pick.id });
    });
  }, [picking, sessionId, capture]);

  // Another tab or page: the frozen frame is no longer what the panel shows.
  useEffect(() => {
    setStage(undefined);
  }, [tab?.id, url]);

  const resume = () => {
    setStage(undefined);
    if (picking !== 'collect' && tab !== undefined) {
      call({ op: 'pick', tab: tab.id, mode: 'collect' });
    }
  };

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
    setStage(undefined);
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
        // The region gets its own card on the frozen page; an earlier result goes away.
        setShot(undefined);
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

  const copyShot = (image: BrowserImage) => {
    void window.piarc
      .browser(sessionId, { op: 'copyImage', image: image.data })
      .then(() => {
        toast(t('browser.shot.copied'));
      })
      .catch(report);
  };
  const saveShot = (image: BrowserImage) => {
    void window.piarc
      .saveImage({ kind: 'png', name: 'screenshot.png', bytes: dataUrlBytes(image.data) })
      .catch(report);
  };

  const surface =
    annotation !== undefined ? (
      <AnnotateSurface
        image={annotation.image}
        mode={annotation.mode}
        onClose={() => {
          setAnnotation(undefined);
        }}
        onRegion={(rect, action, comment) => {
          const source = annotation.image;
          void cropImage(source, rect)
            .then(async (image) => {
              if (action === 'copy') copyShot(image);
              else if (action === 'save') saveShot(image);
              else {
                setAnnotation(undefined);
                await addImage(
                  image,
                  'screenshot',
                  comment === '' ? [] : [regionItem(rect, comment)],
                );
              }
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
    ) : stage !== undefined && cards.length > 0 ? (
      <PickSurface
        stage={stage}
        cards={cards}
        onFocus={(id) => {
          setStage({ ...stage, focus: id });
        }}
        onComment={(id, comment) => {
          setPickComment(sessionId, id, comment);
        }}
        onRemove={(id) => {
          removePick(sessionId, id);
          const last = picksOf(sessionId).at(-1);
          if (last === undefined) setStage(undefined);
          else if (stage.focus === id) setStage({ ...stage, focus: last.pick.id });
        }}
        onClear={() => {
          clearPicks(sessionId);
          setStage(undefined);
        }}
        onContinue={resume}
        onHide={() => {
          setStage(undefined);
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
    ) : null;

  const strips =
    shot === undefined ? null : (
      <ShotBar
        image={shot.image}
        kind={shot.kind}
        onCopy={() => {
          copyShot(shot.image);
        }}
        onSave={() => {
          saveShot(shot.image);
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
    frozen: annotation !== undefined || (stage !== undefined && cards.length > 0),
    pending: cards.length,
    pick,
    annotate,
    screenshot,
    surface,
    strips,
    menu,
    onKeyDown,
  };
}
