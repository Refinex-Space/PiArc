// PiArc's own line icons (16 px grid, `currentColor`), drawn as React SVG elements.
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDashed,
  CircleStop,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Image,
  Info,
  Plug,
  RotateCcw,
  Search,
  Split,
  SquareTerminal,
  TextSelect,
  Type,
  TriangleAlert,
  WrapText,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

function Icon({
  children,
  label,
  strokeWidth = 1.5,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly strokeWidth?: number;
}) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
    >
      {children}
    </svg>
  );
}

export function PlusIcon({ strokeWidth = 1.5 }: { readonly strokeWidth?: number } = {}) {
  return (
    <Icon strokeWidth={strokeWidth}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

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

export const GearIcon = () => (
  <Icon>
    <path
      d="m6.7 1.4-.4 1.5-1 .6-1.5-.4-1.3 2.2 1.1 1.1v1.2L2.5 8.7l1.3 2.2 1.5-.4 1 .6.4 1.5h2.6l.4-1.5 1-.6 1.5.4 1.3-2.2-1.1-1.1V6.4l1.1-1.1-1.3-2.2-1.5.4-1-.6-.4-1.5z"
      transform="translate(0 1)"
    />
    <circle cx="8" cy="8" r="2.1" />
  </Icon>
);

export const FolderIcon = () => (
  <Icon>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Icon>
);

export const PinIcon = ({ label }: { readonly label: string }) => (
  <Icon label={label}>
    <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />
  </Icon>
);

export const ArrowUpIcon = () => (
  <Icon>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
);

/** Lucide `corner-down-left`, the return mark on a selected search row. */
export const ReturnIcon = () => (
  <Icon>
    <path d="M13.33 2.67v4.67a2.67 2.67 0 0 1-2.67 2.67H2.67" />
    <path d="m6 6.67-3.33 3.33 3.33 3.33" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="6.8" cy="6.8" r="4.9" />
    <path d="m10.5 10.5 3.6 3.6" />
  </Icon>
);
export const ChevronLeftIcon = () => (
  <Icon>
    <path d="m9.7 3.3-4.6 4.7 4.6 4.7" />
  </Icon>
);
export const ChevronRightIcon = () => (
  <Icon>
    <path d="m6.3 3.3 4.6 4.7-4.6 4.7" />
  </Icon>
);
export const ChevronDownIcon = () => (
  <Icon>
    <path d="m4 6 4 4 4-4" />
  </Icon>
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
export const CheckIcon = () => (
  <Icon>
    <path d="m2.8 8.7 3.4 3.4L13.2 4" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8m0-8-8 8" />
  </Icon>
);
export function MoreIcon({ dot = 1.1 }: { readonly dot?: number } = {}) {
  return (
    <Icon>
      {[3, 8, 13].map((x) => (
        <circle key={x} cx={x} cy="8" r={dot} fill="currentColor" stroke="none" />
      ))}
    </Icon>
  );
}
export const ComputerIcon = () => (
  <Icon>
    <rect x="3.1" y="2.9" width="9.8" height="7.7" rx="1.2" />
    <path d="M1.5 11h13v1.3c0 .7-.6 1.2-1.3 1.2H2.8c-.8 0-1.3-.5-1.3-1.2z" />
  </Icon>
);
export const RailIcon = () => (
  <Icon>
    <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="2" />
    <path d="M9.5 2.6v10.8m1.9-7.5h1m-1 2.4h1" />
  </Icon>
);
/** Lucide `layout-list`, scaled onto the 16px grid. */
export const LayoutListIcon = () => (
  <Icon>
    <rect x="2" y="2" width="4.67" height="4.67" rx="0.67" />
    <rect x="2" y="9.33" width="4.67" height="4.67" rx="0.67" />
    <path d="M9.33 2.67h4.67M9.33 6h4.67M9.33 10h4.67M9.33 13.33h4.67" />
  </Icon>
);
export const TerminalIcon = () => (
  <Icon>
    <path d="m2.3 3.8 4.1 4.1-4.1 4.2M8.5 12h5.3" />
  </Icon>
);
export const ChangesIcon = () => (
  <Icon>
    <rect x="2" y="1.7" width="12" height="12.6" rx="1.8" />
    <path d="M5.9 6h4.2M8 4v4m-2.1 2.8h4.2" />
  </Icon>
);
export const TasksIcon = () => (
  <Icon>
    <path d="m1.9 4.1 1.3 1.3 2.2-2.6M7.4 4.2h6.2M2.1 8.5h2.4m2.9 0h6.2M2.1 12.5h2.4m2.9 0h6.2" />
  </Icon>
);
export const SideChatIcon = () => (
  <Icon>
    <path d="M2 3.2h8.5v6H6.3l-3.4 2V9.2H2zM6.8 11.7h3.3l3 1.9v-2H14V6.8h-1.3" />
  </Icon>
);
export const ArchiveIcon = () => (
  <Icon>
    <path d="M2.9 6v7h10.2V6M6.4 8.6h3.2" />
    <rect x="1.7" y="2.3" width="12.6" height="3.3" rx=".7" />
  </Icon>
);
export const CommandIcon = () => (
  <Icon>
    <rect x="2" y="2" width="12" height="12" rx="2.4" />
    <path d="m6 11.3 4-6.6" />
  </Icon>
);
export const SendIcon = () => (
  <Icon>
    <path d="M13.5 3.5v3.3A2.7 2.7 0 0 1 10.8 9.5H2.7m3.9-3.7-4 3.7 4 3.4" />
  </Icon>
);
export const StopIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />
  </Icon>
);
export const PaperclipIcon = () => (
  <Icon>
    <path d="m5.4 9.1 5.1-5a1.7 1.7 0 0 1 2.4 2.4l-6 5.9a3.1 3.1 0 0 1-4.4-4.4l6-5.9" />
  </Icon>
);
export const FileIcon = () => (
  <Icon>
    <path d="M3.4 2h6L13 5.8v8.1H3.4zM9 2.3v4h3.5" />
  </Icon>
);
/** Lucide `file-code-corner`, scaled onto the 16px grid. */
export const FileCodeCornerIcon = () => (
  <Icon>
    <path d="M2.67 8.1V2.67a1.33 1.33 0 0 1 1.33-1.33h5.33a1.6 1.6 0 0 1 1.14.47l2.39 2.39A1.6 1.6 0 0 1 13.33 5.33v8a1.33 1.33 0 0 1-1.33 1.33h-2.23" />
    <path d="M9.33 1.33v3.33a.67.67 0 0 0 .67.67h3.33" />
    <path d="m3.33 10.67-2 2 2 2M6 14.67l2-2-2-2" />
  </Icon>
);
/** Lucide `layout-freeform`, scaled onto the 16px grid. */
export const LayoutFreeformIcon = () => (
  <Icon>
    <rect x="2" y="2" width="4.67" height="4.67" rx="0.67" />
    <rect x="9.33" y="2.67" width="4.67" height="4.67" rx="0.67" />
    <rect x="2.67" y="9.33" width="4.67" height="4.67" rx="0.67" />
  </Icon>
);
/** Lucide `unplug`, scaled onto the 16px grid. */
export const UnplugIcon = () => (
  <Icon>
    <path d="m12.67 3.33 2-2M1.33 14.67l2-2" />
    <path d="M4.2 13.53a1.6 1.6 0 0 0 2.27 0L8 12l-4-4-1.53 1.53a1.6 1.6 0 0 0 0 2.27Z" />
    <path d="M5 9 6.67 7.33M7 11l1.67-1.67" />
    <path d="m8 4 4 4 1.53-1.53a1.6 1.6 0 0 0 0-2.27l-1.73-1.73a1.6 1.6 0 0 0-2.27 0Z" />
  </Icon>
);

export const GripIcon = () => (
  <Icon>
    <path
      d="M5.5 3.5h.01m4.99 0h.01M5.5 8h.01m4.99 0h.01M5.5 12.5h.01m4.99 0h.01"
      strokeWidth="2.4"
    />
  </Icon>
);

export const PreviewIcon = () => (
  <Icon>
    <path d="M3.5 2.6a.6.6 0 0 1 .9-.5l9 5.4a.6.6 0 0 1 0 1l-9 5.4a.6.6 0 0 1-.9-.5Z" />
  </Icon>
);
/** Lucide `pencil`, scaled onto the 16px grid. */
export const PencilIcon = () => (
  <Icon>
    <path d="M14.12 4.54a.67.67 0 0 0-2.66-2.66L2.56 10.78a1.33 1.33 0 0 0-.33.55l-.88 2.9a.33.33 0 0 0 .42.42l2.9-.88a1.33 1.33 0 0 0 .55-.33z" />
    <path d="m10 3.33 2.67 2.67" />
  </Icon>
);
export const GlobeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6.2" />
    <ellipse cx="8" cy="8" rx="2.6" ry="6.2" />
    <path d="M2 8h12" />
  </Icon>
);
export const ExpandIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4m0-4-4.3 4.3M6.5 13.5h-4v-4m0 4 4.3-4.3" />
  </Icon>
);
export const RestoreIcon = () => (
  <Icon>
    <path d="M9 3.1v4h4m-4 0 4.4-4.4M7 12.9v-4H3m4 0-4.4 4.4" />
  </Icon>
);
/** Lucide `maximize`, scaled onto the 16px grid. */
export const MaximizeIcon = () => (
  <Icon>
    <path d="M5.33 2H3.33a1.33 1.33 0 0 0-1.33 1.33v2M14 5.33V3.33A1.33 1.33 0 0 0 12.67 2h-2M2 10.67v2A1.33 1.33 0 0 0 3.33 14h2M10.67 14h2a1.33 1.33 0 0 0 1.33-1.33v-2" />
  </Icon>
);
/** Lucide `minimize`, scaled onto the 16px grid. */
export const MinimizeIcon = () => (
  <Icon>
    <path d="M5.33 2v2A1.33 1.33 0 0 1 4 5.33H2M14 5.33h-2A1.33 1.33 0 0 1 10.67 4V2M2 10.67h2A1.33 1.33 0 0 1 5.33 12v2M10.67 14v-2a1.33 1.33 0 0 1 1.33-1.33h2" />
  </Icon>
);
export const PopoutIcon = () => (
  <Icon>
    <rect x="5" y="2" width="9" height="8.5" rx="1.6" />
    <path d="M5 5H3.6C2.7 5 2 5.7 2 6.6v5.7c0 .9.7 1.7 1.6 1.7h6c.9 0 1.6-.8 1.6-1.7v-1.8" />
  </Icon>
);

// ---- Lucide glyphs (ISC, lucide-react 1.66.0) ----
// The session pane draws its line icons from Lucide through this one entry, with the stroke held
// at the reference's optical weights: 12 px at 1, 16 px and 20 px at 1.25 (ADR-0078). Glyphs
// Lucide lacks are drawn above on the same 16 px grid.

/** The icon sizes the session pane uses (CSS px). */
export type GlyphSize = 12 | 16 | 20;

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

export const CopyGlyph = glyph(Copy);
export const CheckGlyph = glyph(Check);
export const RewindGlyph = glyph(RotateCcw);
export const BranchGlyph = glyph(Split);
export const SelectTurnGlyph = glyph(TextSelect);
export const PlainTextGlyph = glyph(Type);
export const CaretGlyph = glyph(ChevronRight);
export const CaretDownGlyph = glyph(ChevronDown);
export const CaretUpGlyph = glyph(ChevronUp);
export const ArrowDownGlyph = glyph(ArrowDown);
export const CloseGlyph = glyph(X);
export const TerminalGlyph = glyph(SquareTerminal);
export const FileGlyph = glyph(FileText);
export const ImageGlyph = glyph(Image);
export const SearchGlyph = glyph(Search);
export const GlobeGlyph = glyph(Globe);
export const PlugGlyph = glyph(Plug);
export const AgentGlyph = glyph(Bot);
export const WarningGlyph = glyph(TriangleAlert);
export const InfoGlyph = glyph(Info);
export const PendingGlyph = glyph(Circle);
export const BlockedGlyph = glyph(CircleDashed);
export const WrapGlyph = glyph(WrapText);
export const ExternalGlyph = glyph(ExternalLink);
export const StopGlyph = glyph(CircleStop);

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
