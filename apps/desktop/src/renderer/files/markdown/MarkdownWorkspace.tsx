import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { useT } from '../../app/app-context.js';
import { useSession } from '../../store/hooks.js';
import { markdownTarget } from '../../transcript/markdown/text.js';
import { fileLocation, parentPath, projectFileRoot } from '../file-path.js';
import { openProjectFile } from '../navigation.js';
import { IconButton } from '../../app/IconButton.js';
import { MenuPopup, useMenu } from '../../shell/Menu.js';
import { RailIcon } from '../../shell/icons.js';
import { useToolVisible } from '../../shell/ToolHeaderSlot.js';
import { useMarkdownImages } from '../markdown-images/use-markdown-images.js';
import { SplitDivider } from './SplitDivider.js';
import { FileMarkdown, type MarkdownReaderHandle } from '../viewer-markdown.js';
import type { FileLocation } from '../viewer-source.js';
import type { ViewerSettings, FileSelection, FindMatch } from '../viewer-model.js';
import type { MarkdownEditorHandle } from './MarkdownEditor.js';
import type { FileMode } from './MarkdownModes.js';
import { markdownEditingBlock } from './RichBlock.js';
import { MarkdownMediaContext } from './MediaContextHost.js';
import { MarkdownImage } from './MarkdownImage.js';
import type { ParseReply } from './document.worker.js';
import type { Heading } from './document-model.js';

const Editor = lazy(async () => ({
  default: (await import('./MarkdownEditor.js')).MarkdownEditor,
}));
export interface MarkdownWorkspaceHandle {
  focus: () => void;
  findReplace: () => void;
}
interface Props {
  ref?: Ref<MarkdownWorkspaceHandle>;
  sessionId: string;
  path: string;
  text: string;
  editable: boolean;
  settings: ViewerSettings;
  visible: boolean;
  mode: FileMode;
  location?: FileLocation | undefined;
  match?: FindMatch | undefined;
  onChange: (s: string) => void;
  onSelect: (selection: FileSelection | undefined) => void;
}
export function MarkdownWorkspace({
  ref,
  sessionId,
  path,
  text,
  editable,
  settings,
  visible,
  mode,
  location,
  match,
  onChange,
  onSelect,
}: Props) {
  const t = useT(),
    images = useMarkdownImages(sessionId, path),
    editor = useRef<MarkdownEditorHandle | null>(null),
    reader = useRef<MarkdownReaderHandle | null>(null);
  const project = projectFileRoot(useSession(sessionId));
  const anchorLookup = useRef<Worker | null>(null);
  useLayoutEffect(
    () => () => {
      anchorLookup.current?.terminate();
      anchorLookup.current = null;
    },
    [sessionId, path, text, mode],
  );
  const followLink = (href: string) => {
    if (href.startsWith('#') && !/^#L\d/u.test(href)) {
      let slug: string;
      try {
        slug = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      // The explicit navigation uses the same anchor and duplicate-heading mapping as reading.
      anchorLookup.current?.terminate();
      const worker = new Worker(new URL('./document.worker.ts', import.meta.url), {
        type: 'module',
        name: 'markdown-anchor',
      });
      anchorLookup.current = worker;
      const finish = () => {
        worker.terminate();
        if (anchorLookup.current === worker) anchorLookup.current = null;
      };
      worker.onmessage = (event: MessageEvent<ParseReply>) => {
        if (anchorLookup.current === worker) {
          const match = event.data.document?.headings.find((h) => h.slug === slug);
          if (match) editor.current?.scrollToLine(match.line);
        }
        finish();
      };
      worker.onerror = (error) => {
        console.error('[files] resolving Markdown anchor failed', error.message);
        finish();
      };
      worker.postMessage({ sequence: 1, text });
      return;
    }
    const target = markdownTarget(href);
    if (target.href) {
      void window.piarc.openExternal(target.href).catch((error: unknown) => {
        console.error('[files] opening Markdown link failed', error);
      });
    } else if (project && target.projectTarget) {
      const relative = target.projectTarget;
      const to = fileLocation(
        relative.startsWith('#') ? path + relative : relative,
        project,
        relative.startsWith('#') ? '' : parentPath(path),
      );
      if (to) openProjectFile(sessionId, to);
    }
  };
  const root = useRef<HTMLDivElement>(null),
    topLine = useRef(1);
  const placed = useToolVisible();
  const painted = visible && placed;
  const [stacked, setStacked] = useState(false),
    [ratio, setRatio] = useState(0.5);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setStacked(el.clientWidth < 540);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  const [initialized, setInitialized] = useState(mode !== 'preview');
  if (mode !== 'preview' && !initialized) setInitialized(true);
  const [headings, setHeadings] = useState<readonly Heading[]>([]);
  const menu = useMenu(),
    pendingFind = useRef(false);
  const mounted = useCallback((view: MarkdownEditorHandle | null) => {
    editor.current = view;
    if (view && topLine.current > 1) view.scrollToLine(topLine.current);
    if (view && pendingFind.current) {
      pendingFind.current = false;
      view.findReplace();
    }
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        editor.current?.focus();
      },
      findReplace() {
        if (editor.current) editor.current.findReplace();
        else pendingFind.current = true;
      },
    }),
    [],
  );
  const renderImage = useCallback(
    (source: string, alt: string) => (
      <MarkdownImage sessionId={sessionId} path={path} source={source} alt={alt} editing />
    ),
    [sessionId, path],
  );
  const split = mode === 'split';
  useLayoutEffect(() => {
    if (visible && topLine.current > 1) {
      if (mode !== 'preview') editor.current?.scrollToLine(topLine.current);
      if (mode === 'preview' || mode === 'split') reader.current?.scrollToLine(topLine.current);
    }
  }, [mode, visible]);
  const scrollReader = useCallback(
    (line: number) => {
      topLine.current = line;
      if (split) reader.current?.scrollToLine(line);
    },
    [split],
  );
  const scrollEditor = useCallback(
    (line: number) => {
      topLine.current = line;
      if (split) editor.current?.scrollToLine(line);
    },
    [split],
  );
  return (
    <div
      className="markdown-workspace"
      ref={root}
      data-layout={mode}
      data-stacked={stacked}
      style={
        split
          ? stacked
            ? {
                gridTemplateRows: `minmax(0,${String(ratio)}fr) 1px minmax(0,${String(1 - ratio)}fr)`,
              }
            : {
                gridTemplateColumns: `minmax(0,${String(ratio)}fr) 1px minmax(0,${String(1 - ratio)}fr)`,
              }
          : undefined
      }
    >
      {initialized && (
        <div className="markdown-writing" hidden={mode === 'preview'}>
          <Suspense fallback={<span role="status">{t('files.viewer.loading')}</span>}>
            <Editor
              ref={mounted}
              sessionId={sessionId}
              path={path}
              text={text}
              mode={mode === 'edit' ? 'live' : 'source'}
              editable={editable}
              visible={painted && mode !== 'preview'}
              settings={settings}
              location={location}
              match={match}
              onChange={onChange}
              onSelect={onSelect}
              importImages={images.importFiles}
              chooseImage={images.choose}
              onImageSettings={images.openSettings}
              renderImage={renderImage}
              followLink={followLink}
              renderBlock={markdownEditingBlock}
              onScrollLine={scrollReader}
            />
          </Suspense>
        </div>
      )}
      {split && <SplitDivider stacked={stacked} ratio={ratio} change={setRatio} />}
      {(mode === 'preview' || split) && painted && (
        <div className="markdown-reading">
          <FileMarkdown
            sessionId={sessionId}
            path={path}
            text={text}
            readerRef={reader}
            onHeadings={setHeadings}
            onScrollLine={scrollEditor}
            {...(editable
              ? {
                  onChange: (value: string) => {
                    if (editor.current) editor.current.applyUserChange(value);
                    else onChange(value);
                  },
                }
              : {})}
          />
          {headings.length > 0 && (
            <div className="markdown-outline">
              <IconButton
                label={t('files.md.outline')}
                aria-haspopup="menu"
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  menu.openAt(b.right, b.bottom, e.currentTarget);
                }}
              >
                <RailIcon />
              </IconButton>
            </div>
          )}
        </div>
      )}
      {menu.open && (
        <MenuPopup
          at={menu.open}
          label={t('files.md.outline')}
          filterLabel={t('files.md.findHeading')}
          items={headings.map((h) => ({
            id: h.slug,
            label: h.title,
            run: () => {
              reader.current?.scrollToLine(h.line);
              if (split) editor.current?.scrollToLine(h.line);
            },
          }))}
          onClose={menu.close}
        />
      )}
      <MarkdownMediaContext
        root={root}
        sessionId={sessionId}
        path={path}
        text={text}
        visible={painted}
      />
      {images.dialogs}
    </div>
  );
}
