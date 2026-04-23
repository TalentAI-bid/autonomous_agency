import type { CSSProperties, ReactElement, SVGProps } from 'react';

export type IconName =
  | 'dash' | 'bot' | 'users' | 'build' | 'deal' | 'chart'
  | 'mail' | 'flag' | 'cog' | 'plus' | 'play' | 'pause'
  | 'search' | 'bell' | 'filter' | 'caret' | 'arrow'
  | 'arrowUp' | 'arrowDn' | 'check' | 'x' | 'eye'
  | 'brain' | 'zap' | 'doc' | 'globe' | 'calendar'
  | 'target' | 'radio' | 'send' | 'msg' | 'database'
  | 'star' | 'reply' | 'commandLine' | 'signOut';

const PATHS: Record<IconName, ReactElement> = {
  dash:   <><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></>,
  bot:    <><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M12 3v4M8 12h.01M16 12h.01M9 17h6"/></>,
  users:  <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="7" r="2.5"/><path d="M15 20c0-2 2-4 4-4"/></>,
  build:  <><rect x="4" y="3" width="7" height="18"/><rect x="13" y="8" width="7" height="13"/><path d="M7 7h1M7 11h1M7 15h1M16 12h1M16 16h1"/></>,
  deal:   <><path d="M3 7h18v12H3z"/><path d="M3 7l4-4h10l4 4M8 12h8"/></>,
  chart:  <><path d="M3 20V5M21 20H5"/><path d="M8 16l3-4 3 2 4-6"/></>,
  mail:   <><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 7l9 6 9-6"/></>,
  flag:   <><path d="M5 21V4M5 4h12l-3 4 3 4H5"/></>,
  cog:    <><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></>,
  plus:   <><path d="M12 5v14M5 12h14"/></>,
  play:   <><path d="M7 4v16l13-8z" fill="currentColor"/></>,
  pause:  <><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></>,
  bell:   <><path d="M6 8a6 6 0 1112 0v4l2 3H4l2-3V8zM9 19a3 3 0 006 0"/></>,
  filter: <><path d="M3 5h18l-7 9v5l-4 2v-7L3 5z"/></>,
  caret:  <><path d="M6 9l6 6 6-6"/></>,
  arrow:  <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  arrowUp: <><path d="M12 19V5M6 11l6-6 6 6"/></>,
  arrowDn: <><path d="M12 5v14M6 13l6 6 6-6"/></>,
  check:  <><path d="M5 12l4 4 10-10"/></>,
  x:      <><path d="M6 6l12 12M18 6L6 18"/></>,
  eye:    <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
  brain:  <><path d="M9 4a3 3 0 00-3 3c0 .4.1.8.2 1.1A3 3 0 005 11c0 1 .3 1.9.9 2.6A3 3 0 006 17a3 3 0 003 3h3V4H9z"/><path d="M15 4a3 3 0 013 3c0 .4-.1.8-.2 1.1A3 3 0 0119 11c0 1-.3 1.9-.9 2.6A3 3 0 0118 17a3 3 0 01-3 3h-3"/></>,
  zap:    <><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></>,
  doc:    <><path d="M14 3H6v18h12V7l-4-4z"/><path d="M14 3v4h4"/></>,
  globe:  <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 9h18M8 3v4M16 3v4"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></>,
  radio:  <><circle cx="12" cy="12" r="2"/><path d="M7.7 16.3a6 6 0 010-8.6M16.3 7.7a6 6 0 010 8.6M4.2 19.8a10 10 0 010-15.6M19.8 4.2a10 10 0 010 15.6"/></>,
  send:   <><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></>,
  msg:    <><path d="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  star:   <><path d="M12 3l2.6 6.2 6.4.5-4.9 4.3 1.5 6.5L12 17l-5.6 3.5 1.5-6.5L3 9.7l6.4-.5L12 3z"/></>,
  reply:  <><path d="M9 17L4 12l5-5M4 12h12a4 4 0 014 4v3"/></>,
  commandLine: <><path d="M4 17l6-6-6-6M12 19h8"/></>,
  signOut: <><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3"/></>,
};

export function Icon({
  name,
  size = 14,
  color = 'currentColor',
  style,
  ...rest
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: CSSProperties;
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'color' | 'size' | 'style'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
      {...rest}
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
