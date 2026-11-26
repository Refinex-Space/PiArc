// Category glyphs use a common 20-unit grid and inherit the navigation item's foreground.
import type { ReactNode } from 'react';
import { GearIcon } from '../shell/icons.js';

const symbols: Record<string, ReactNode> = {
  markdown: (
    <>
      <rect x="2" y="4" width="16" height="12" rx="2" />
      <path d="M5 13V7l2.5 3L10 7v6m4-6v6m-2-2 2 2 2-2" />
    </>
  ),
  appearance: (
    <>
      <path d="M17.8 8.8c0 2.4-1.9 3.5-4 3.2-1.3-.2-2 .6-1.7 1.8.4 1.9-.5 3.6-2.6 3.6a7.4 7.4 0 1 1 8.3-8.6Z" />
      <circle cx="6.2" cy="9" r=".7" />
      <circle cx="9" cy="6.2" r=".7" />
      <circle cx="13" cy="6.7" r=".7" />
    </>
  ),
  providers: <path d="m11.2 2-8 10h5.5l-.4 6 8-10.5h-5.4z" />,
  permissions: <path d="m10 2 6.5 2.5V9c0 4-3 7-6.5 9-3.5-2-6.5-5-6.5-9V4.5z M7 9.5l2 2 4-4" />,
  sandbox: <path d="m10 2 7 4v8l-7 4-7-4V6z M3 6l7 4 7-4 M10 10v8" />,
  proxy: (
    <>
      <circle cx="10" cy="10" r="7.6" />
      <path d="M2.4 10h15.2 M10 2.4c2.1 2.2 3.2 4.7 3.2 7.6s-1.1 5.4-3.2 7.6c-2.1-2.2-3.2-4.7-3.2-7.6S7.9 4.6 10 2.4Z" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="4.5" r="2" />
      <circle cx="6" cy="15.5" r="2" />
      <circle cx="14" cy="7" r="2" />
      <path d="M6 6.5v7 M14 9c0 3.5-8 2.5-8 4.5" />
    </>
  ),
  agents: (
    <>
      <circle cx="7.3" cy="6.3" r="2.6" />
      <path d="M2.2 16v-1.5c0-4 10.2-4 10.2 0V16z M13 4c3 .1 3.8 4.5.8 5.2m.2 2.4c2.8.1 4 1.5 4 4" />
    </>
  ),
  skills: (
    <>
      <rect x="2.5" y="3" width="10" height="10" rx="2" />
      <rect x="7.8" y="8" width="9.8" height="9.5" rx="2" />
    </>
  ),
  memory: (
    <path d="M4 3h10.5A1.5 1.5 0 0 1 16 4.5v13H5.5A2.5 2.5 0 0 1 3 15V5a2 2 0 0 1 2-2Zm-.8 12.5c0-1.3 1-2 2.3-2H16 M7 6.5h6" />
  ),
  mcp: (
    <>
      <path d="m15.83 4.17 2.5-2.5M1.67 18.33l2.5-2.5" />
      <path d="M5.25 16.92a2 2 0 0 0 2.83 0L10 15l-5-5-1.92 1.92a2 2 0 0 0 0 2.83Z" />
      <path d="M6.25 11.25 8.33 9.17M8.75 13.75l2.08-2.08" />
      <path d="m10 5 5 5 1.92-1.92a2 2 0 0 0 0-2.83l-2.17-2.17a2 2 0 0 0-2.83 0Z" />
    </>
  ),
  usage: (
    <>
      <path d="M3.2 15a7.4 7.4 0 1 1 13.6 0 M10 11.5l3.2-4.2" />
      <circle cx="10" cy="11.5" r=".8" />
    </>
  ),
  diagnostics: <path d="M2 10h3l2.3-5.4 4.2 11 2.7-7 1.4 1.4H18" />,
  shortcuts: (
    <>
      <rect x="1.6" y="4" width="16.8" height="12" rx="2.4" />
      <path d="M5 8h.4m3 0h.4m3 0h.4m3 0h.4M6 12h8" />
    </>
  ),
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="5.7" />
      <path d="m12.8 12.8 4.5 4.5" />
    </>
  ),
  close: <path d="m4.8 4.8 10.4 10.4m0-10.4L4.8 15.2" />,
};

export function SettingsIcon({ name }: { readonly name: string }) {
  const symbol = symbols[name];
  if (!symbol) return <GearIcon />;
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbol}
    </svg>
  );
}
