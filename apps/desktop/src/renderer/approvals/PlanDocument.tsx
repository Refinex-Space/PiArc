// A plan as the plan panel shows it (ADR-0103): rendered by the Files Markdown reader, so a plan
// reads exactly like a Markdown file in the Files tool, with each section tagged with the source
// lines it comes from. A plan under review takes inline comments:
// selecting a passage opens the comment field next to it, a marked passage opens its comment
// again. Marks and the passage being commented are custom highlights (`::highlight()`), so the
// rendered DOM stays exactly what the Markdown renderer made and the anchors stay UTF-16 offsets
// of the source (`plan-dom.ts`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

import { useT } from '../app/app-context.js';
import { useParsedDocument } from '../files/markdown/use-parsed-document.js';
import { MarkdownReader } from '../files/viewer-markdown.js';
import { PlanCommentPopover } from './PlanCommentPopover.js';
import { planComments, usePlanComments } from './plan-comments.js';
import { pointToSource, selectionToSource, sourceToRanges } from './plan-dom.js';

/** Highlight names (styled in app.css with `::highlight()`). */
const MARKS = 'piarc-plan-comment';
const FOCUSED = 'piarc-plan-comment-focus';

type Editor =
  | { readonly kind: 'new'; readonly start: number; readonly end: number }
  | { readonly kind: 'edit'; readonly id: string; readonly start: number; readonly end: number };

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | undefined {
  const position = doc.caretPositionFromPoint(x, y);
  if (position !== null) return { node: position.offsetNode, offset: position.offset };
  return undefined;
}

/** The rectangle the comment field sits against: the passage's last line, and its first line's
 * top for when the field flips above. */
function passageRect(root: Element, plan: string, start: number, end: number) {
  const ranges = sourceToRanges(root, plan, start, end);
  const firstRects = ranges[0]?.getClientRects();
  const lastRects = ranges.at(-1)?.getClientRects();
  const first = firstRects?.[0];
  const last = lastRects?.[lastRects.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { left: last.left, right: last.right, top: first.top, bottom: last.bottom };
}

export function PlanDocument({
  sessionId,
  plan,
  requestId,
}: {
  readonly sessionId: string;
  readonly plan: string;
  /** The plan card waiting for review: without one the plan is read-only. */
  readonly requestId?: string | undefined;
}) {
  const t = useT();
  const parsed = useParsedDocument(plan);
  const document = parsed?.source === plan ? parsed.document : undefined;
  const root = useRef<HTMLDivElement>(null);
  const comments = usePlanComments(requestId);
  const [editor, setEditor] = useState<Editor | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // The renderer changes text nodes after the first paint (code highlighting): marks follow.
  const [domVersion, setDomVersion] = useState(0);

  useEffect(() => {
    const element = root.current;
    const win = element?.ownerDocument.defaultView;
    if (element === null || win === null || win === undefined) return;
    let frame = 0;
    const observer = new win.MutationObserver(() => {
      win.cancelAnimationFrame(frame);
      frame = win.requestAnimationFrame(() => {
        setDomVersion((v) => v + 1);
      });
    });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      win.cancelAnimationFrame(frame);
    };
  }, []);

  // The card's list asks for a comment: open it here.
  useEffect(
    () =>
      planComments.onOpen((request, id) => {
        if (request !== requestId) return;
        const comment = planComments.get(request).find((c) => c.id === id);
        if (comment === undefined) return;
        setError(undefined);
        setEditor({ kind: 'edit', id, start: comment.start, end: comment.end });
        const first =
          root.current === null
            ? undefined
            : sourceToRanges(root.current, plan, comment.start, comment.end)[0];
        first?.startContainer.parentElement?.scrollIntoView({ block: 'nearest' });
      }),
    [requestId, plan],
  );

  // A comment that is gone (removed from the card) closes its editor.
  useEffect(() => {
    if (editor?.kind === 'edit' && !comments.some((c) => c.id === editor.id)) setEditor(undefined);
  }, [comments, editor]);

  useLayoutEffect(() => {
    const element = root.current;
    const win = element?.ownerDocument.defaultView;
    const registry = win?.CSS.highlights;
    if (element === null || win === null || win === undefined || registry === undefined) return;
    const marks = comments.flatMap((c) => sourceToRanges(element, plan, c.start, c.end));
    registry.set(MARKS, new win.Highlight(...marks));
    const focused =
      editor === undefined ? [] : sourceToRanges(element, plan, editor.start, editor.end);
    registry.set(FOCUSED, new win.Highlight(...focused));
    return () => {
      registry.delete(MARKS);
      registry.delete(FOCUSED);
    };
  }, [comments, editor, plan, document, domVersion]);

  const reviewing = requestId !== undefined;
  // The open field holds text the user has not saved: a new selection does not replace it.
  const unsaved = useRef(false);
  const pick = useCallback(() => {
    const element = root.current;
    const selection = element?.ownerDocument.getSelection();
    if (!reviewing || element === null || !selection || selection.isCollapsed) return;
    if (selection.rangeCount === 0 || unsaved.current) return;
    const range = selection.getRangeAt(0);
    // A selection that runs past the plan's text is clipped to it.
    if (!range.intersectsNode(element)) return;
    const found = selectionToSource(element, range, plan);
    if (found === undefined) return;
    setError(undefined);
    // A passage already commented on opens its comment rather than a second one.
    const overlap = comments.find((c) => found.start < c.end && c.start < found.end);
    setEditor(
      overlap === undefined
        ? { kind: 'new', ...found }
        : { kind: 'edit', id: overlap.id, start: overlap.start, end: overlap.end },
    );
  }, [reviewing, plan, comments]);

  const clicked = (event: MouseEvent<HTMLDivElement>) => {
    const element = root.current;
    const doc = element?.ownerDocument;
    if (!reviewing || element === null || doc === undefined) return;
    const selection = doc.getSelection();
    if ((selection !== null && !selection.isCollapsed) || unsaved.current) return;
    const caret = caretAt(doc, event.clientX, event.clientY);
    const at =
      caret === undefined ? undefined : pointToSource(element, caret.node, caret.offset, plan);
    const hit = at === undefined ? undefined : comments.find((c) => at >= c.start && at < c.end);
    if (hit === undefined) return;
    setError(undefined);
    setEditor({ kind: 'edit', id: hit.id, start: hit.start, end: hit.end });
  };

  const anchor = useCallback(() => {
    const element = root.current;
    return element === null || editor === undefined
      ? undefined
      : passageRect(element, plan, editor.start, editor.end);
  }, [editor, plan]);
  // The field stays inside the plan's area.
  const area = useCallback(() => root.current?.getBoundingClientRect(), []);

  const dismiss = useCallback(() => {
    unsaved.current = false;
    setEditor(undefined);
    setError(undefined);
  }, []);
  // Closing from the field (Esc, save, delete) gives the keyboard back to the plan, where the
  // passage was; a press elsewhere only dismisses it.
  const close = useCallback(() => {
    dismiss();
    root.current?.focus({ preventScroll: true });
  }, [dismiss]);

  const editing = editor?.kind === 'edit' ? comments.find((c) => c.id === editor.id) : undefined;
  return (
    <>
      <div
        ref={root}
        className="plan-doc"
        tabIndex={-1}
        data-testid="plan-text"
        data-reviewing={reviewing}
        onPointerUp={() => {
          root.current?.ownerDocument.defaultView?.requestAnimationFrame(pick);
        }}
        onKeyUp={(event) => {
          if (event.key === 'Shift') pick();
        }}
        onClick={clicked}
      >
        {/* No `path`: the plan is no file; links and images resolve from the project root. */}
        <MarkdownReader parsed={parsed} sessionId={sessionId} path="" text={plan} />
      </div>
      {editor !== undefined && root.current !== null && requestId !== undefined ? (
        <PlanCommentPopover
          key={editor.kind === 'edit' ? editor.id : `${String(editor.start)}-${String(editor.end)}`}
          host={root.current.ownerDocument}
          area={area}
          anchor={anchor}
          initial={editing?.text ?? ''}
          editing={editing !== undefined}
          error={error}
          onClose={close}
          onDismiss={dismiss}
          onChange={(dirty) => {
            unsaved.current = dirty;
          }}
          onSave={(text) => {
            const saved =
              editor.kind === 'edit'
                ? planComments.update(requestId, editor.id, text)
                : planComments.add(requestId, plan, editor.start, editor.end, text);
            if (!saved) {
              setError(t('plan.panel.overlap'));
              return;
            }
            root.current?.ownerDocument.getSelection()?.removeAllRanges();
            close();
          }}
          onDelete={
            editing === undefined
              ? undefined
              : () => {
                  planComments.remove(requestId, editing.id);
                  close();
                }
          }
        />
      ) : null}
    </>
  );
}
