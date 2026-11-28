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
import { useToolVisible } from '../../shell/ToolHeaderSlot.js';
import { useMarkdownImages } from '../markdown-images/use-markdown-images.js';
import { SplitDivider } from './SplitDivider.js';
import { MarkdownReader, type MarkdownReaderHandle } from '../viewer-markdown.js';
import type { FileLocation } from '../viewer-source.js';
import type { ViewerSettings, FileSelection, FindMatch } from '../viewer-model.js';
import type { MarkdownEditorHandle } from './MarkdownEditor.js';
import type { FileMode } from './MarkdownModes.js';
import { markdownEditingBlock } from './RichBlock.js';
import { MarkdownMediaContext } from './MediaContextHost.js';
import { MarkdownImage } from './MarkdownImage.js';
import { useParsedDocument } from './use-parsed-document.js';
import { MarkdownOutline, headingAtLine } from './MarkdownOutline.js';
import type { Heading } from './document-model.js';

const noHeadings: readonly Heading[] = [];
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
  const followLink = (href: string) => {
    if (href.startsWith('#') && !/^#L\d/u.test(href)) {
      let slug: string;
      try {
        slug = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      setAnchor(slug);
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
  const parsed = useParsedDocument(
    text,
    painted ? (mode === 'preview' || mode === 'split' ? 'document' : 'outline') : false,
  );
  const headings = parsed?.document?.headings ?? parsed?.headings ?? noHeadings;
  const [anchor, setAnchor] = useState<string>();
  const [activeHeading, setActiveHeading] = useState(0);
  const pendingFind = useRef(false);
  useLayoutEffect(() => {
    setActiveHeading(headingAtLine(headings, topLine.current));
    if (anchor && parsed?.source === text) {
      const heading = headings.find((h) => h.slug === anchor);
      if (heading) editor.current?.scrollToLine(heading.line);
      setAnchor(undefined);
    }
  }, [headings, anchor, parsed?.source, text]);
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
      setActiveHeading(headingAtLine(headings, line));
      if (split) reader.current?.scrollToLine(line);
    },
    [split, headings],
  );
  const scrollEditor = useCallback(
    (line: number) => {
      topLine.current = line;
      setActiveHeading(headingAtLine(headings, line));
      if (split) editor.current?.scrollToLine(line);
    },
    [split, headings],
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
          <MarkdownReader
            sessionId={sessionId}
            path={path}
            text={text}
            readerRef={reader}
            parsed={parsed}
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
        </div>
      )}
      {painted && headings.length >= 2 && (
        <MarkdownOutline
          key={path}
          headings={headings}
          active={activeHeading}
          jump={(heading, index) => {
            topLine.current = heading.line;
            setActiveHeading(index);
            if (mode !== 'preview') editor.current?.scrollToLine(heading.line);
            if (mode === 'preview' || split) reader.current?.scrollToLine(heading.line);
          }}
        />
      )}
      <MarkdownMediaContext
        root={root}
        sessionId={sessionId}
        path={path}
        text={text}
        visible={painted}
      />
    </div>
  );
}
