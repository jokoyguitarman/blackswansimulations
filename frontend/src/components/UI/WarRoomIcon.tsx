/**
 * War Room icon set — the custom stroke glyphs from the design studies
 * (docs/design/warroom/icons.svg + warroom-entry.html). One component, no emoji.
 *
 *   <WrIcon name="building" size={14} />
 *
 * Stroke inherits `currentColor`; size is the font-size in px.
 */
import type { CSSProperties } from 'react';

const PATHS = {
  building:
    'M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16 M14 9h5a1 1 0 0 1 1 1v11 M8 8h2M8 12h2M8 16h2M17 13h1M17 17h1 M2 21h20',
  office: 'M3 21V8l9-5 9 5v13 M3 21h18 M9 21v-5h6v5 M8 11h2M14 11h2M8 15h2M14 15h2',
  megaphone:
    'M3 11v2a1 1 0 0 0 1 1h2l5 4V6l-5 4H4a1 1 0 0 0-1 1z M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10',
  scale: 'M12 3v18M6 21h12M4 7h16 M7 7l-3 7a3 3 0 0 0 6 0L7 7zM17 7l-3 7a3 3 0 0 0 6 0l-3-7z',
  tie: 'M9 3h6l-1 4 2 10-4 4-4-4 2-10-1-4z',
  truck:
    'M3 7h11v9H3zM14 10h4l3 3v3h-7z M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  handshake: 'M2 10l4-4 4 3 3-1 5 3 4-3 M2 10l4 4 3 3 3 2 3-2 3-3 4-4 M9 13l2 2M12 11l2 2',
  users:
    'M9 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M17 9m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M3 20a6 6 0 0 1 12 0M15 20a4.5 4.5 0 0 1 6 0',
  landmark: 'M3 21h18M5 21V10M9.5 21V10M14.5 21V10M19 21V10 M2 10l10-6 10 6z',
  fist: 'M7 12V8a2 2 0 1 1 4 0v3 M11 11V6a2 2 0 1 1 4 0v5 M15 11V8a2 2 0 1 1 4 0v6a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-2a2 2 0 1 1 4 0',
  leaf: 'M4 20c0-9 6-15 16-16-1 10-7 16-16 16z M4 20l8-8',
  community: 'M12 3l9 6v12H3V9z M9 21v-6h6v6 M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  podium: 'M8 21V11h8v10 M4 21h16 M10 11V7h4v4 M12 3v4',
  swords: 'M3 3l8 8M14 14l3 3M3 21l6-6M21 3l-8 8M10 14l-3 3M21 21l-6-6 M6 15l3 3M15 6l3 3',
  radar:
    'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0 M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M12 12l6-6',
  doc: 'M6 3h8l4 4v14H6z M14 3v4h4M9 12h6M9 16h6',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  lock: 'M5 11h14v10H5z M8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M5 11h14v10H5z M8 11V8a4 4 0 0 1 7.5-2',
  check: 'M5 12l4 4L19 6',
  alert: 'M12 3l10 18H2z M12 10v5M12 18h.01',
  hazard: 'M12 3l10 18H2z M12 10v5M12 18h.01',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  sparkle:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  clock: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 7v5l3 2',
  phone: 'M7 2h10v20H7z M11 18h2',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14M15 6v14',
  pin: 'M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z M12 10m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
  flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  'arrow-l': 'M19 12H5M11 6l-6 6 6 6',
  chevron: 'M9 6l6 6-6 6',
  edit: 'M4 20h4L18 10l-4-4L4 16v4z M13 7l4 4',
  play: 'M7 5v14l11-7z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  'eye-off':
    'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.4 10.4 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C4 8.4 2 12 2 12s4 7 10 7c1.4 0 2.7-.3 3.9-.8',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  save: 'M5 3h11l3 3v15H5z M8 3v6h7V3 M8 21v-7h8v7',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5M3 17l9 5 9-5',
  target:
    'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0 M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M20 20l-3.5-3.5',
  mail: 'M3 5h18v14H3z M3 7l9 6 9-6',
  news: 'M3 4h18v16H3z M7 8h6M7 12h10M7 16h10M16 8h1',
  feed: 'M4 4h16v6H4zM4 14h16v6H4z',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  chat: 'M4 5h16v11H9l-5 4z',
  copy: 'M9 9h12v12H9z M5 15V5a2 2 0 0 1 2-2h10',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  collapse: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  cal: 'M3 5h18v16H3z M3 10h18M8 3v4M16 3v4',
  card: 'M3 6h18v12H3z M3 10h18M7 15h4',
  dash: 'M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  info: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 11v5M12 8h.01',
  // incident glyphs
  bomb: 'M11 14m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M15 9l2-2M17 7l2-2M19 3v2M21 5h-2M14 5l1 2',
  car: 'M3 13l2-5h14l2 5v5H3z M7.5 17m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M16.5 17m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M5 13h14',
  vest: 'M8 3l4 3 4-3 3 5-2 13H7L5 8z M9 12h6M9 16h6',
  mall: 'M3 9l2-5h14l2 5 M4 9h16v12H4z M9 21v-6h6v6',
  gun: 'M3 8h17v5h-5l-1 2H9l-1 4H4l2-6H3z M14 13v-2',
  knife: 'M3 21l6-6 M9 15L20 4c1 3 0 7-4 9l-4 2z',
  bio: 'M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0 M12 3a5 5 0 0 1 4 8M12 3a5 5 0 0 0-4 8M4.5 17a5 5 0 0 1 4-8M19.5 17a5 5 0 0 0-4-8M4.5 17a5 5 0 0 0 7.5 2M19.5 17a5 5 0 0 1-7.5 2',
  skull:
    'M12 3a8 8 0 0 1 8 8c0 3-2 5-3 6v3H7v-3c-1-1-3-3-3-6a8 8 0 0 1 8-8z M9 11m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M15 11m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M11 16h2',
  siren: 'M6 19V12a6 6 0 0 1 12 0v7 M3 19h18v2H3z M12 3v2M5 5l1.5 1.5M19 5l-1.5 1.5',
  plane: 'M2 14l8-2 4-8 2 1-2 7 7 2v2l-7-1-2 6-2 1 0-7-8 1z',
  medic: 'M3 5h18v14H3z M12 9v6M9 12h6',
  fire: 'M12 22c-4 0-7-3-7-7 0-3 2-5 3-7 0 2 1 3 2 3 0-4 2-7 5-9 0 3 1 5 3 7s2 4 2 6c0 4-3 7-8 7z',
} as const;

export type WrIconName = keyof typeof PATHS;

export const WrIcon = ({
  name,
  size = 14,
  className = '',
  style,
  title,
}: {
  name: WrIconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) => (
  <svg
    className={`wr-ic ${className}`}
    style={{ fontSize: size, ...style }}
    viewBox="0 0 24 24"
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
  >
    {title && <title>{title}</title>}
    <path d={PATHS[name]} />
  </svg>
);

/** Team function → glyph. Legacy preset names map to their successors. */
export const TEAM_ICON: Record<string, WrIconName> = {
  Communications: 'megaphone',
  Legal: 'scale',
  Executive: 'tie',
  'Shareholder Engagement': 'handshake',
  'Stakeholder Engagement': 'users',
  Procurement: 'handshake',
  Sales: 'users',
  'Fleet Operations': 'truck',
  Operations: 'truck',
  'Bomb Squad / EOD': 'bomb',
  'Medical Triage': 'medic',
  'Hazards / Fire / Rescue': 'fire',
  'Incident Command': 'shield',
  'Police / Cordon': 'siren',
  Forensics: 'search',
  'Public Information': 'megaphone',
  Logistics: 'truck',
};

export const teamIcon = (teamName: string | null | undefined): WrIconName => {
  if (!teamName) return 'users';
  if (TEAM_ICON[teamName]) return TEAM_ICON[teamName];
  const base = teamName.split(' — ')[0].split(' - ')[0].trim();
  if (TEAM_ICON[base]) return TEAM_ICON[base];
  const lower = teamName.toLowerCase();
  if (/comm|media|press/.test(lower)) return 'megaphone';
  if (/legal|counsel|compliance/.test(lower)) return 'scale';
  if (/exec|leader|board|c-suite/.test(lower)) return 'tie';
  if (/fleet|logistic|ops|operation|supply/.test(lower)) return 'truck';
  if (/hr|people|driver|labour|labor|workforce|union/.test(lower)) return 'users';
  if (/investor|shareholder|finance/.test(lower)) return 'handshake';
  if (/medic|triage|health/.test(lower)) return 'medic';
  if (/fire|hazmat|rescue/.test(lower)) return 'fire';
  if (/eod|bomb/.test(lower)) return 'bomb';
  if (/command/.test(lower)) return 'shield';
  return 'users';
};

/** Field-ops incident type id → glyph. */
export const INCIDENT_ICON: Record<string, WrIconName> = {
  bombing: 'bomb',
  car_bomb: 'car',
  suicide_bombing: 'vest',
  bombing_mall: 'mall',
  open_field_shooting: 'gun',
  knife_attack: 'knife',
  gas_attack: 'bio',
  poisoning: 'skull',
  kidnapping: 'siren',
  hijacking: 'plane',
  custom: 'sparkle',
};

/** Pressure-organisation kind → glyph. */
export const PRESSURE_ICON: Record<string, WrIconName> = {
  regulator: 'landmark',
  union: 'fist',
  ngo: 'leaf',
  community_group: 'community',
  political: 'podium',
};
