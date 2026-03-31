/**
 * Tactical SVG icons for map markers.
 * All icons are 16x16 viewBox, white fill, designed for dark circular pin backgrounds.
 * Use `svg(key)` to get the inline SVG string for a DivIcon.
 */

const S = 16; // viewBox size

const paths: Record<string, string> = {
  // ── Incidents / Hazards ──
  explosion: `<path d="M8 1l2 4 4 1-3 3 1 5-4-2-4 2 1-5-3-3 4-1z" fill="white"/>`,
  fire: `<path d="M8 1C8 1 4 5 4 9a4 4 0 008 0C12 5 8 1 8 1zm0 12a2 2 0 01-2-2c0-1.5 2-4 2-4s2 2.5 2 4a2 2 0 01-2 2z" fill="white"/>`,
  chemical: `<circle cx="8" cy="8" r="6" fill="none" stroke="white" stroke-width="1.5"/><path d="M8 2v4M5.5 5l2 3.5M10.5 5l-2 3.5M8 14v-4M5.5 11l2-3.5M10.5 11l-2-3.5" stroke="white" stroke-width="1.2"/>`,
  collapse: `<path d="M3 13h10M5 13V7l3-4 3 4v6M7 13v-3h2v3" fill="none" stroke="white" stroke-width="1.5"/>`,
  debris: `<path d="M2 14l3-5 2 2 3-4 3 3 1-3" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/><rect x="5" y="10" width="3" height="3" fill="white" rx="0.5"/>`,
  gas: `<path d="M3 11c1-2 3-1 4-3s1-4 3-4M5 14c1-2 3-1 4-3s1-4 3-4" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>`,
  flood: `<path d="M2 8c1.5-2 3 0 4.5-2S9 6 10.5 8 13 6 14 8M2 12c1.5-2 3 0 4.5-2s2.5 0 4 2 2.5-2 3.5 0" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>`,
  biohazard: `<circle cx="8" cy="8" r="2" fill="white"/><path d="M8 2a6 6 0 00-5.2 3M8 2a6 6 0 015.2 3M2.8 11a6 6 0 005.2 3M13.2 11a6 6 0 01-5.2 3M2.8 5a6 6 0 000 6M13.2 5a6 6 0 010 6" fill="none" stroke="white" stroke-width="1.2"/>`,
  electrical: `<path d="M10 1L5 8h3l-2 7 6-8H9l2-6z" fill="white"/>`,
  smoke: `<path d="M4 13c0-2 2-2 2-4s-1-3 1-5M8 13c0-2 2-2 2-4s-1-3 1-5M12 13c0-2 1-2 1-4" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>`,
  hazard_generic: `<path d="M8 2L2 13h12L8 2z" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="6" x2="8" y2="10" stroke="white" stroke-width="1.5"/><circle cx="8" cy="12" r="0.8" fill="white"/>`,

  // ── Access / Entry-Exit ──
  door: `<rect x="4" y="2" width="8" height="12" rx="1" fill="none" stroke="white" stroke-width="1.5"/><circle cx="10" cy="9" r="1" fill="white"/>`,
  door_blocked: `<rect x="4" y="2" width="8" height="12" rx="1" fill="none" stroke="white" stroke-width="1.5"/><line x1="3" y1="3" x2="13" y2="13" stroke="white" stroke-width="1.5"/>`,

  // ── Cordon / Perimeter ──
  cordon: `<line x1="2" y1="2" x2="14" y2="14" stroke="white" stroke-width="2"/><circle cx="2" cy="2" r="1.5" fill="white"/><circle cx="14" cy="14" r="1.5" fill="white"/><line x1="14" y1="2" x2="2" y2="14" stroke="white" stroke-width="1" opacity="0.5"/>`,

  // ── Medical / Triage ──
  medical_cross: `<rect x="6" y="2" width="4" height="12" rx="1" fill="white"/><rect x="2" y="6" width="12" height="4" rx="1" fill="white"/>`,
  triage: `<path d="M8 2v12M4 6h8" stroke="white" stroke-width="2"/><circle cx="8" cy="2" r="1" fill="white"/>`,

  // ── Command / Operations ──
  command: `<circle cx="8" cy="8" r="5" fill="none" stroke="white" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="white"/><line x1="8" y1="3" x2="8" y2="5" stroke="white" stroke-width="1.2"/><line x1="8" y1="11" x2="8" y2="13" stroke="white" stroke-width="1.2"/><line x1="3" y1="8" x2="5" y2="8" stroke="white" stroke-width="1.2"/><line x1="11" y1="8" x2="13" y2="8" stroke="white" stroke-width="1.2"/>`,

  // ── Routes / Transport ──
  route: `<path d="M8 2v3M8 11v3M5 6.5h6M5 9.5h6" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5" r="1.5" fill="#dc2626"/><circle cx="8" cy="8" r="1.5" fill="#eab308"/><circle cx="8" cy="11" r="1.5" fill="#22c55e"/>`,

  // ── Staging / Assembly ──
  staging: `<path d="M8 2l6 5v7H2V7l6-5z" fill="none" stroke="white" stroke-width="1.5"/><rect x="6" y="9" width="4" height="5" fill="white" rx="0.5"/>`,
  flag: `<line x1="4" y1="2" x2="4" y2="14" stroke="white" stroke-width="1.5"/><path d="M4 2h8l-2 3 2 3H4" fill="white" opacity="0.9"/>`,

  // ── Facilities ──
  hospital: `<rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="white" stroke-width="1.5"/><rect x="7" y="5" width="2" height="6" fill="white"/><rect x="5" y="7" width="6" height="2" fill="white"/>`,
  police: `<path d="M8 1l2 3h3l-1 3 2 3h-3l-3 3-3-3H2l2-3-1-3h3z" fill="none" stroke="white" stroke-width="1.2"/>`,
  fire_station: `<path d="M8 2C8 2 5 6 5 9a3 3 0 006 0C11 6 8 2 8 2z" fill="none" stroke="white" stroke-width="1.5"/><path d="M8 7c0 0-1.5 1.5-1.5 2.5a1.5 1.5 0 003 0C9.5 8.5 8 7 8 7z" fill="white"/>`,

  // ── Surveillance / Media ──
  camera: `<rect x="3" y="5" width="8" height="6" rx="1" fill="none" stroke="white" stroke-width="1.5"/><path d="M11 7l3-2v6l-3-2" fill="white"/>`,
  broadcast: `<circle cx="8" cy="10" r="2" fill="white"/><path d="M4 6a5.5 5.5 0 018 0" fill="none" stroke="white" stroke-width="1.5"/><path d="M6 8a2.5 2.5 0 014 0" fill="none" stroke="white" stroke-width="1.5"/>`,
  community: `<path d="M3 14v-3a2 2 0 012-2h6a2 2 0 012 2v3" fill="none" stroke="white" stroke-width="1.5"/><rect x="5" y="2" width="6" height="5" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="2" x2="8" y2="1" stroke="white" stroke-width="1.5"/>`,

  // ── Casualties ──
  person: `<circle cx="8" cy="4" r="2" fill="white"/><path d="M5 14v-4a3 3 0 016 0v4" fill="none" stroke="white" stroke-width="1.5"/>`,
  person_trapped: `<circle cx="8" cy="4" r="2" fill="white"/><path d="M5 14v-4a3 3 0 016 0v4" fill="none" stroke="white" stroke-width="1.2"/><line x1="3" y1="7" x2="13" y2="7" stroke="white" stroke-width="1.5"/><line x1="3" y1="10" x2="13" y2="10" stroke="white" stroke-width="1.5"/>`,
  stretcher: `<rect x="2" y="6" width="12" height="4" rx="1" fill="none" stroke="white" stroke-width="1.5"/><circle cx="4" cy="12" r="1.5" fill="white"/><circle cx="12" cy="12" r="1.5" fill="white"/><line x1="4" y1="10" x2="4" y2="10.5" stroke="white" stroke-width="1.5"/><line x1="12" y1="10" x2="12" y2="10.5" stroke="white" stroke-width="1.5"/>`,
  deceased: `<line x1="4" y1="4" x2="12" y2="12" stroke="white" stroke-width="2"/><line x1="12" y1="4" x2="4" y2="12" stroke="white" stroke-width="2"/>`,
  resolved: `<path d="M3 8l3 4 7-8" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // ── Crowds ──
  crowd: `<circle cx="5" cy="5" r="2" fill="white"/><circle cx="11" cy="5" r="2" fill="white"/><circle cx="8" cy="4" r="2" fill="white"/><path d="M2 14v-3a3 3 0 016 0v3M8 14v-3a3 3 0 016 0v3" fill="none" stroke="white" stroke-width="1"/>`,
  eye: `<ellipse cx="8" cy="8" rx="6" ry="4" fill="none" stroke="white" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="white"/>`,
  heart_broken: `<path d="M8 14s-6-4-6-8a3.5 3.5 0 017-1 3.5 3.5 0 017 1c0 4-6 8-6 8z" fill="none" stroke="white" stroke-width="1.3"/><line x1="8" y1="4" x2="7" y2="8" stroke="white" stroke-width="1.2"/><line x1="7" y1="8" x2="9" y2="9" stroke="white" stroke-width="1.2"/>`,
  handshake: `<path d="M2 8h3l2 2 2-2 2 2 2-2h1" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 6h3M11 6h3" fill="none" stroke="white" stroke-width="1.5"/>`,

  // ── Resources / Vehicles ──
  ambulance: `<rect x="1" y="5" width="10" height="7" rx="1" fill="none" stroke="white" stroke-width="1.3"/><path d="M11 7h3l1 3v2h-4" fill="none" stroke="white" stroke-width="1.3"/><circle cx="4" cy="13" r="1.5" fill="white"/><circle cx="13" cy="13" r="1.5" fill="white"/><path d="M5 7v3M3.5 8.5h3" stroke="white" stroke-width="1.2"/>`,
  police_car: `<rect x="2" y="6" width="12" height="6" rx="1" fill="none" stroke="white" stroke-width="1.3"/><path d="M4 6V4h8v2" fill="none" stroke="white" stroke-width="1.3"/><circle cx="5" cy="13" r="1.5" fill="white"/><circle cx="11" cy="13" r="1.5" fill="white"/><rect x="6" y="3" width="4" height="2" rx="0.5" fill="white"/>`,
  fire_truck: `<rect x="1" y="6" width="10" height="6" rx="1" fill="none" stroke="white" stroke-width="1.3"/><path d="M11 8h3l1 2v2h-4" fill="none" stroke="white" stroke-width="1.3"/><circle cx="4" cy="13" r="1.5" fill="white"/><circle cx="13" cy="13" r="1.5" fill="white"/><line x1="3" y1="3" x2="3" y2="6" stroke="white" stroke-width="1.5"/>`,
  helicopter: `<ellipse cx="8" cy="9" rx="4" ry="2.5" fill="none" stroke="white" stroke-width="1.5"/><line x1="12" y1="9" x2="15" y2="10" stroke="white" stroke-width="1.5"/><line x1="3" y1="5" x2="13" y2="5" stroke="white" stroke-width="1.5"/><line x1="8" y1="5" x2="8" y2="7" stroke="white" stroke-width="1.5"/>`,
  military: `<path d="M8 2l6 4-2 8H4L2 6z" fill="none" stroke="white" stroke-width="1.5"/>`,
  supply: `<rect x="3" y="4" width="10" height="8" rx="1" fill="none" stroke="white" stroke-width="1.5"/><path d="M3 7h10" stroke="white" stroke-width="1"/><path d="M6 4V2h4v2" fill="none" stroke="white" stroke-width="1.3"/>`,

  // ── Medical Equipment ──
  syringe: `<path d="M12 2l2 2-1 1-2-2zM4 10l5-5 2 2-5 5H4z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><line x1="4" y1="12" x2="4" y2="14" stroke="white" stroke-width="1.5"/>`,
  bandage: `<rect x="3" y="6" width="10" height="5" rx="2.5" fill="none" stroke="white" stroke-width="1.5"/><line x1="6" y1="6" x2="6" y2="11" stroke="white" stroke-width="1"/><line x1="10" y1="6" x2="10" y2="11" stroke="white" stroke-width="1"/><circle cx="8" cy="8.5" r="0.8" fill="white"/>`,
  splint: `<rect x="4" y="2" width="3" height="12" rx="0.5" fill="none" stroke="white" stroke-width="1.3"/><rect x="9" y="2" width="3" height="12" rx="0.5" fill="none" stroke="white" stroke-width="1.3"/><line x1="7" y1="5" x2="9" y2="5" stroke="white" stroke-width="1.2"/><line x1="7" y1="8" x2="9" y2="8" stroke="white" stroke-width="1.2"/><line x1="7" y1="11" x2="9" y2="11" stroke="white" stroke-width="1.2"/>`,
  heartbeat: `<path d="M2 8h3l1.5-3 2 6 1.5-3H14" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  oxygen_mask: `<circle cx="8" cy="6" r="4" fill="none" stroke="white" stroke-width="1.5"/><path d="M6 10v3a2 2 0 004 0v-3" fill="none" stroke="white" stroke-width="1.5"/><line x1="4" y1="6" x2="2" y2="4" stroke="white" stroke-width="1.2"/><line x1="12" y1="6" x2="14" y2="4" stroke="white" stroke-width="1.2"/>`,

  // ── Floor Plan Features ──
  escalator: `<path d="M3 13l10-10" stroke="white" stroke-width="1.5"/><path d="M5 13h-2v-2M13 5v-2h-2" stroke="white" stroke-width="1.5" stroke-linecap="round"/><line x1="6" y1="11" x2="8" y2="9" stroke="white" stroke-width="1"/><line x1="8" y1="9" x2="10" y2="7" stroke="white" stroke-width="1"/><line x1="4" y1="9" x2="6" y2="7" stroke="white" stroke-width="1"/>`,
  elevator: `<rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="4" x2="8" y2="12" stroke="white" stroke-width="1.2"/><path d="M5.5 7l2.5-3 2.5 3" fill="none" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10l2.5 3 2.5-3" fill="none" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  stairs: `<path d="M2 14h3v-3h3v-3h3v-3h3V2" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>`,
  exit_sign: `<rect x="2" y="4" width="12" height="8" rx="1" fill="none" stroke="white" stroke-width="1.3"/><path d="M9 6v4M9 8h2" stroke="white" stroke-width="1.3"/><path d="M5 11l2-3-2-3" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  corridor: `<path d="M2 4h12M2 12h12M5 4v8M11 4v8" fill="none" stroke="white" stroke-width="1.3"/>`,
  room: `<rect x="3" y="3" width="10" height="10" rx="1" fill="none" stroke="white" stroke-width="1.5"/><rect x="6" y="9" width="4" height="4" fill="none" stroke="white" stroke-width="1.2"/>`,
  food_court: `<path d="M4 2v5a2 2 0 004 0V2" fill="none" stroke="white" stroke-width="1.3"/><line x1="6" y1="7" x2="6" y2="14" stroke="white" stroke-width="1.3"/><path d="M10 2v4c0 1.5 1 2 2 2V2" fill="none" stroke="white" stroke-width="1.3"/><line x1="12" y1="8" x2="12" y2="14" stroke="white" stroke-width="1.3"/>`,
  retail: `<path d="M2 6l1-4h10l1 4" fill="none" stroke="white" stroke-width="1.3"/><path d="M2 6c0 1.1.9 2 2 2s2-.9 2-2c0 1.1.9 2 2 2s2-.9 2-2c0 1.1.9 2 2 2s2-.9 2-2" fill="none" stroke="white" stroke-width="1.2"/><rect x="3" y="8" width="10" height="6" fill="none" stroke="white" stroke-width="1.3"/>`,
  restroom: `<circle cx="5" cy="3" r="1.5" fill="white"/><path d="M5 5v4M3 7h4M5 9l-2 5M5 9l2 5" stroke="white" stroke-width="1.2"/><circle cx="11" cy="3" r="1.5" fill="white"/><path d="M9 5h4v4h-1.5v5h-1v-5H9z" fill="white"/>`,
  fire_alarm: `<path d="M4 6a4 4 0 018 0" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="6" x2="8" y2="10" stroke="white" stroke-width="1.5"/><circle cx="8" cy="12" r="2" fill="none" stroke="white" stroke-width="1.5"/><line x1="3" y1="3" x2="5" y2="5" stroke="white" stroke-width="1.2"/><line x1="13" y1="3" x2="11" y2="5" stroke="white" stroke-width="1.2"/>`,
  parking: `<path d="M5 14V2h4a4 4 0 010 8H5" fill="none" stroke="white" stroke-width="2"/>`,
  office: `<rect x="2" y="4" width="12" height="10" rx="1" fill="none" stroke="white" stroke-width="1.3"/><line x1="2" y1="7" x2="14" y2="7" stroke="white" stroke-width="1"/><rect x="4" y="9" width="3" height="2" fill="white" rx="0.3"/><line x1="9" y1="9.5" x2="12" y2="9.5" stroke="white" stroke-width="1"/><line x1="9" y1="11.5" x2="11" y2="11.5" stroke="white" stroke-width="1"/>`,
  ventilation: `<circle cx="8" cy="8" r="6" fill="none" stroke="white" stroke-width="1.3"/><path d="M8 2c-2 2-2 4 0 6M8 14c2-2 2-4 0-6M2 8c2 2 4 2 6 0M14 8c-2-2-4-2-6 0" stroke="white" stroke-width="1.2"/>`,

  // ── Equipment / Assets ──
  barrier: `<rect x="2" y="5" width="12" height="3" rx="0.5" fill="white"/><rect x="2" y="9" width="12" height="3" rx="0.5" fill="white" opacity="0.6"/><line x1="4" y1="12" x2="4" y2="14" stroke="white" stroke-width="1.5"/><line x1="12" y1="12" x2="12" y2="14" stroke="white" stroke-width="1.5"/>`,
  tent: `<path d="M2 13h12M3 13L8 4l5 9" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="4" x2="8" y2="1" stroke="white" stroke-width="1.5"/>`,
  radio: `<rect x="5" y="5" width="6" height="9" rx="1" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="5" x2="11" y2="1" stroke="white" stroke-width="1.5"/><circle cx="8" cy="11" r="1.5" fill="white"/>`,
  water: `<path d="M8 2C8 2 4 7 4 10a4 4 0 008 0c0-3-4-8-4-8z" fill="none" stroke="white" stroke-width="1.5"/>`,
  hexagon: `<path d="M8 2l5 3v6l-5 3-5-3V5z" fill="none" stroke="white" stroke-width="1.5"/>`,
  extinguisher: `<rect x="6" y="5" width="4" height="9" rx="1" fill="none" stroke="white" stroke-width="1.5"/><path d="M8 5V3M6 3h4" stroke="white" stroke-width="1.5"/><path d="M10 6l2-2" stroke="white" stroke-width="1.2"/>`,
  clipboard: `<rect x="4" y="3" width="8" height="11" rx="1" fill="none" stroke="white" stroke-width="1.5"/><path d="M6 3V2h4v1" fill="none" stroke="white" stroke-width="1.2"/><line x1="6" y1="7" x2="10" y2="7" stroke="white" stroke-width="1"/><line x1="6" y1="9.5" x2="10" y2="9.5" stroke="white" stroke-width="1"/><line x1="6" y1="12" x2="9" y2="12" stroke="white" stroke-width="1"/>`,
  mask: `<path d="M4 6h8a2 2 0 010 4l-1 2H5l-1-2a2 2 0 010-4z" fill="none" stroke="white" stroke-width="1.5"/>`,

  // ── Severity ──
  alert_critical: `<circle cx="8" cy="8" r="6" fill="none" stroke="white" stroke-width="1.5"/><line x1="8" y1="5" x2="8" y2="9" stroke="white" stroke-width="2"/><circle cx="8" cy="11.5" r="1" fill="white"/>`,
  pin: `<path d="M8 1a5 5 0 00-5 5c0 4 5 9 5 9s5-5 5-9a5 5 0 00-5-5zm0 7a2 2 0 110-4 2 2 0 010 4z" fill="white"/>`,

  // ── Incident ──
  siren: `<path d="M4 10h8v3H4z" fill="none" stroke="white" stroke-width="1.5"/><path d="M6 10V8a2 2 0 014 0v2" fill="none" stroke="white" stroke-width="1.5"/><path d="M3 7l-1-2M13 7l1-2M8 4V2" stroke="white" stroke-width="1.2"/>`,
};

export function svg(key: string, size = 16): string {
  const p = paths[key];
  if (!p)
    return paths.pin
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">${paths.pin}</svg>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">${p}</svg>`;
}

export const iconKeys = Object.keys(paths);
