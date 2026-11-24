// PiArc's own line icons (16 px grid, `currentColor`), drawn as React SVG elements.
import type { ReactNode } from 'react';

function Icon({ children, label }: { readonly children: ReactNode; readonly label?: string }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
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

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const SidebarIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6 3v10" />
  </Icon>
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
export const MoreIcon = () => (
  <Icon>
    {[3, 8, 13].map((x) => (
      <circle key={x} cx={x} cy="8" r="1.1" fill="currentColor" stroke="none" />
    ))}
  </Icon>
);
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
export const PopoutIcon = () => (
  <Icon>
    <rect x="5" y="2" width="9" height="8.5" rx="1.6" />
    <path d="M5 5H3.6C2.7 5 2 5.7 2 6.6v5.7c0 .9.7 1.7 1.6 1.7h6c.9 0 1.6-.8 1.6-1.7v-1.8" />
  </Icon>
);
