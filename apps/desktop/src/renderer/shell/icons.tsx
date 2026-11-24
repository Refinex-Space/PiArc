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
