// PiArc's icons, the one entry for the whole app (ADR-0078): Lucide shapes (ISC, lucide-react
// 1.66.0) at fixed sizes and stroke weights through `glyph`, and the few filled marks Lucide
// lacks, drawn here on the same grid. Toolbars may thin the stroke to 1 in CSS.
import {
  AppWindow,
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Code,
  CircleDashed,
  CircleStop,
  Copy,
  Download,
  CornerDownLeft,
  Ellipsis,
  Eye,
  ExternalLink,
  File as FileShape,
  FileCodeCorner,
  FileDiff,
  FileText,
  Folder,
  Globe,
  GripVertical,
  Image,
  Info,
  Laptop,
  LayoutFreeform,
  LayoutList,
  ListTodo,
  Maximize,
  Maximize2,
  MessagesSquare,
  Minimize,
  Minimize2,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Play,
  Plug,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Split,
  SquareSlash,
  SquareTerminal,
  Terminal,
  TextSelect,
  Type,
  TriangleAlert,
  Unplug,
  WandSparkles,
  WrapText,
  X,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  CircleAlert,
  EllipsisVertical,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  List,
  Minus,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Tag,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

/** The icon sizes the app uses (CSS px). */
export type GlyphSize = 12 | 16 | 20;

/** A Lucide shape at a fixed size, its stroke held at 1 (12 px) or 1.25 (16 and 20 px). */
function glyph(Shape: LucideIcon) {
  function Glyph({ size = 16, label }: { readonly size?: GlyphSize; readonly label?: string }) {
    return (
      <Shape
        className="icon"
        size={size}
        strokeWidth={size === 12 ? 1 : 1.25}
        nonScalingStroke
        aria-hidden={label === undefined ? true : undefined}
        role={label === undefined ? undefined : 'img'}
        aria-label={label}
        focusable="false"
      />
    );
  }
  Glyph.displayName = `Glyph(${Shape.displayName ?? 'icon'})`;
  return Glyph;
}

// ---- Workbench and session icons ----

export const PlusIcon = glyph(Plus);
export const GearIcon = glyph(Settings);
export const FolderIcon = glyph(Folder);
export const PinIcon = glyph(Pin);
export const ArrowUpIcon = glyph(ArrowUp);
/** The return mark on a selected search row, and the composer's send. */
export const ReturnIcon = glyph(CornerDownLeft);
export const SendIcon = ReturnIcon;
export const SearchIcon = glyph(Search);
export const ChevronLeftIcon = glyph(ChevronLeft);
export const ChevronRightIcon = glyph(ChevronRight);
export const ChevronDownIcon = glyph(ChevronDown);
export const CheckIcon = glyph(Check);
export const CloseIcon = glyph(X);
export const MoreIcon = glyph(Ellipsis);
export const ComputerIcon = glyph(Laptop);
export const RailIcon = glyph(PanelRight);
export const LayoutListIcon = glyph(LayoutList);
export const TerminalIcon = glyph(Terminal);
export const ChangesIcon = glyph(FileDiff);
export const TasksIcon = glyph(ListTodo);
export const SideChatIcon = glyph(MessagesSquare);
export const ArchiveIcon = glyph(Archive);
export const CommandIcon = glyph(SquareSlash);
export const PaperclipIcon = glyph(Paperclip);
export const FileIcon = glyph(FileShape);
export const FileCodeCornerIcon = glyph(FileCodeCorner);
export const LayoutFreeformIcon = glyph(LayoutFreeform);
export const UnplugIcon = glyph(Unplug);
export const GripIcon = glyph(GripVertical);
export const PreviewIcon = glyph(Play);
export const PencilIcon = glyph(Pencil);
export const GlobeIcon = glyph(Globe);
export const ExpandIcon = glyph(Maximize2);
export const RestoreIcon = glyph(Minimize2);
export const MaximizeIcon = glyph(Maximize);
export const MinimizeIcon = glyph(Minimize);
export const PopoutIcon = glyph(AppWindow);

// ---- Git panel (ADR-0084) ----

export const GitBranchIcon = glyph(GitBranch);
export const GitCommitIcon = glyph(GitCommitHorizontal);
export const GitMergeIcon = glyph(GitMerge);
export const ArrowRightIcon = glyph(ArrowRight);
/** The changed files list toggle. */
export const FileListIcon = glyph(List);
export const MoreVerticalIcon = glyph(EllipsisVertical);
export const FetchIcon = glyph(RefreshCw);
export const PullIcon = glyph(ArrowDownToLine);
export const PushIcon = glyph(ArrowUpFromLine);
export const GenerateIcon = glyph(Sparkles);
/** A pull request on GitHub (G5). */
export const PullRequestIcon = glyph(GitPullRequest);
/** An AI review of the changes (G5). */
export const ReviewIcon = glyph(ScanSearch);
export const RollbackIcon = glyph(Undo2);
export const MinusIcon = glyph(Minus);
export const TagIcon = glyph(Tag);
export const AlertIcon = glyph(CircleAlert);

// ---- Filled marks Lucide lacks ----

export const SidebarIcon = () => (
  <svg
    className="icon"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M4.65 3.23H11.35A3.02 3.02 0 0 1 14.37 6.25V10.55A3.02 3.02 0 0 1 11.35 13.57H4.65A3.02 3.02 0 0 1 1.63 10.55V6.25A3.02 3.02 0 0 1 4.65 3.23ZM4.66 4.18H11.34A2.08 2.08 0 0 1 13.42 6.26V10.54A2.08 2.08 0 0 1 11.34 12.62H4.66A2.08 2.08 0 0 1 2.58 10.54V6.26A2.08 2.08 0 0 1 4.66 4.18Z"
    />
    <rect x="4.43" y="6.03" width="0.95" height="4.74" rx="0.47" />
  </svg>
);

/** Solid disclosure mark beside a project name. Points right; the row rotates it when open. */
export function DisclosureIcon() {
  return (
    <svg
      className="icon project-caret"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M7.76 4.47 10.65 7.05a1.28 1.28 0 0 1 0 1.9l-2.89 2.58A1.28 1.28 0 0 1 5.62 10.57V5.43A1.28 1.28 0 0 1 7.76 4.47Z"
      />
    </svg>
  );
}

/** The composer's stop: a filled rounded square. */
export function StopIcon() {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

// ---- Session pane glyphs ----

export const CopyGlyph = glyph(Copy);
export const CheckGlyph = CheckIcon;
export const RewindGlyph = glyph(RotateCcw);
export const BranchGlyph = glyph(Split);
export const SelectTurnGlyph = glyph(TextSelect);
export const PlainTextGlyph = glyph(Type);
export const CaretGlyph = ChevronRightIcon;
export const CaretDownGlyph = ChevronDownIcon;
export const CaretUpGlyph = glyph(ChevronUp);
export const ArrowDownGlyph = glyph(ArrowDown);
export const CloseGlyph = CloseIcon;
export const TerminalGlyph = glyph(SquareTerminal);
export const FileGlyph = glyph(FileText);
export const ImageGlyph = glyph(Image);
export const SearchGlyph = SearchIcon;
export const GlobeGlyph = GlobeIcon;
export const PlugGlyph = glyph(Plug);
export const AgentGlyph = glyph(Bot);
export const WarningGlyph = glyph(TriangleAlert);
export const InfoGlyph = glyph(Info);
export const PendingGlyph = glyph(Circle);
export const BlockedGlyph = glyph(CircleDashed);
export const WrapGlyph = glyph(WrapText);
export const ExternalGlyph = glyph(ExternalLink);
export const StopGlyph = glyph(CircleStop);
export const CodeGlyph = glyph(Code);
export const PreviewGlyph = glyph(Eye);
export const DownloadGlyph = glyph(Download);
export const FixGlyph = glyph(WandSparkles);

/** A finished step: a filled disc with the check cut out (Lucide has no filled form). */
export function DoneGlyph({ size = 16 }: { readonly size?: GlyphSize }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" fill="currentColor" />
      <path
        d="m5.2 8.2 1.9 1.9 3.8-4"
        fill="none"
        stroke="var(--piarc-workbench-canvas)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A step in progress: a quarter arc that turns (static under reduced motion). */
export function SpinnerGlyph({ size = 16 }: { readonly size?: GlyphSize }) {
  return (
    <svg
      className="icon spinner-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The disclosure caret of a step row: a small filled triangle pointing right. */
export function StepCaret() {
  return (
    <svg
      className="icon step-caret-glyph"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 3.2v5.6a.4.4 0 0 0 .66.3l3.2-2.8a.4.4 0 0 0 0-.6l-3.2-2.8a.4.4 0 0 0-.66.3z"
        fill="currentColor"
      />
    </svg>
  );
}
