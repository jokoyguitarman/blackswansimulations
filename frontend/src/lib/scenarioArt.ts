/**
 * Deterministic illustration picker for scenario cards and heroes.
 *
 * The 50 scenes live in /public/marketing/library (NN-name.webp 1280px, NN-name-sm.webp 720px).
 * A scenario's art is chosen by matching its title/description against scene tags, then
 * hashing its id inside the matched set — so a card keeps its picture across reloads and
 * two similar scenarios still tend to get different scenes.
 */

export interface ArtScene {
  key: string;
  file: string;
  /** keyword tags; 'corporate' / 'field' mark which family may use the scene */
  tags: string[];
}

export const ART_LIBRARY: ArtScene[] = [
  { key: 'war-room', file: '01-war-room', tags: ['corporate', 'default', 'crisis', 'team'] },
  {
    key: 'executive-window',
    file: '02-executive-window',
    tags: ['corporate', 'default', 'executive', 'ceo', 'board'],
  },
  {
    key: 'press-conference',
    file: '03-press-conference',
    tags: ['corporate', 'press', 'media', 'statement', 'apology'],
  },
  {
    key: 'depot-night',
    file: '04-depot-night',
    tags: ['corporate', 'depot', 'logistics', 'driver', 'freight', 'warehouse'],
  },
  {
    key: 'factory-floor',
    file: '05-factory-floor',
    tags: ['corporate', 'factory', 'manufactur', 'labour', 'labor', 'worker', 'overtime'],
  },
  {
    key: 'hospital-corridor',
    file: '06-hospital-corridor',
    tags: ['corporate', 'hospital', 'clinic', 'patient', 'icu', 'health'],
  },
  {
    key: 'union-hall',
    file: '07-union-hall',
    tags: ['corporate', 'union', 'strike', 'labour', 'labor', 'picket'],
  },
  {
    key: 'inspector-gate',
    file: '08-inspector-gate',
    tags: ['corporate', 'inspect', 'regulator', 'ministry', 'audit'],
  },
  {
    key: 'newsroom',
    file: '09-newsroom',
    tags: ['corporate', 'news', 'journalist', 'media', 'leak'],
  },
  {
    key: 'pile-on',
    file: '10-pile-on',
    tags: ['corporate', 'default', 'viral', 'social', 'boycott', 'backlash', 'trending'],
  },
  {
    key: 'border-bridge',
    file: '11-border-bridge',
    tags: ['corporate', 'border', 'cross-border', 'malaysia', 'johor', 'causeway', 'logistics'],
  },
  {
    key: 'boardroom-decision',
    file: '12-boardroom-decision',
    tags: ['corporate', 'board', 'decision', 'executive', 'governance'],
  },
  { key: 'debrief', file: '13-debrief', tags: ['corporate', 'field', 'debrief', 'review', 'aar'] },
  {
    key: 'trainer-console',
    file: '14-trainer-console',
    tags: ['corporate', 'field', 'trainer', 'console'],
  },
  {
    key: 'leaked-document',
    file: '15-leaked-document',
    tags: ['corporate', 'leak', 'document', 'memo', 'whistle'],
  },
  {
    key: 'protest-lobby',
    file: '16-protest-lobby',
    tags: ['corporate', 'protest', 'community', 'ngo', 'activist', 'demonstration'],
  },
  {
    key: 'whistleblower',
    file: '17-whistleblower',
    tags: ['corporate', 'whistleblower', 'fraud', 'misconduct', 'allegation'],
  },
  {
    key: 'misinformation-web',
    file: '18-misinformation-web',
    tags: ['corporate', 'misinformation', 'rumour', 'rumor', 'disinformation', 'fake'],
  },
  {
    key: 'calm-before',
    file: '19-calm-before',
    tags: ['corporate', 'field', 'default', 'calm', 'morning'],
  },
  {
    key: 'evacuation',
    file: '20-evacuation',
    tags: ['field', 'default', 'evacuat', 'bomb', 'ied', 'blast'],
  },
  {
    key: 'command-post',
    file: '21-command-post',
    tags: ['field', 'default', 'command', 'incident', 'tactical'],
  },
  {
    key: 'responders',
    file: '22-responders',
    tags: ['field', 'default', 'responder', 'fire', 'rescue', 'triage', 'medic'],
  },
  {
    key: 'container-port',
    file: '23-container-port',
    tags: ['corporate', 'field', 'port', 'shipping', 'container', 'maritime', 'sea'],
  },
  {
    key: 'airport-gate',
    file: '24-airport-gate',
    tags: ['corporate', 'field', 'airport', 'airline', 'terminal', 'flight', 'hijack'],
  },
  {
    key: 'data-breach',
    file: '25-data-breach',
    tags: ['corporate', 'data', 'breach', 'cyber', 'hack', 'intrusion', 'ransomware', 'privacy'],
  },
  {
    key: 'product-recall',
    file: '26-product-recall',
    tags: ['corporate', 'recall', 'product', 'safety', 'defect', 'contamin'],
  },
  {
    key: 'corridor-counsel',
    file: '27-corridor-counsel',
    tags: ['corporate', 'legal', 'counsel', 'lawsuit', 'court'],
  },
  {
    key: 'call-chain',
    file: '28-call-chain',
    tags: ['corporate', 'call', 'phone', 'hotline', 'escalation'],
  },
  {
    key: 'clock-pressure',
    file: '29-clock-pressure',
    tags: ['corporate', 'field', 'deadline', 'clock', 'pressure', 'countdown'],
  },
  {
    key: 'town-hall',
    file: '30-town-hall',
    tags: ['corporate', 'town hall', 'community', 'charity', 'association', 'members', 'trust'],
  },
  {
    key: 'headline-storm',
    file: '31-headline-storm',
    tags: ['corporate', 'headline', 'scandal', 'media', 'storm'],
  },
  {
    key: 'hotel-lobby',
    file: '32-hotel-lobby',
    tags: ['corporate', 'field', 'hotel', 'hospitality', 'resort', 'casino', 'lobby'],
  },
  {
    key: 'campus-night',
    file: '33-campus-night',
    tags: ['corporate', 'field', 'campus', 'university', 'school', 'student'],
  },
  {
    key: 'energy-plant',
    file: '34-energy-plant',
    tags: ['corporate', 'field', 'energy', 'plant', 'power', 'utility', 'gas', 'chemical'],
  },
  {
    key: 'tribunal',
    file: '35-tribunal',
    tags: ['corporate', 'tribunal', 'inquiry', 'hearing', 'parliament', 'commission'],
  },
  {
    key: 'trading-floor',
    file: '36-trading-floor',
    tags: ['corporate', 'market', 'bank', 'trading', 'finance', 'liquidity', 'investor', 'shares'],
  },
  {
    key: 'family-tv',
    file: '37-family-tv',
    tags: ['corporate', 'public', 'consumer', 'household', 'broadcast'],
  },
  {
    key: 'driver-rest',
    file: '38-driver-rest',
    tags: ['corporate', 'driver', 'fatigue', 'shift', 'rest', 'transport'],
  },
  {
    key: 'clinic-waiting',
    file: '39-clinic-waiting',
    tags: ['corporate', 'clinic', 'pharma', 'medicine', 'vaccine', 'patient'],
  },
  {
    key: 'timeline-wall',
    file: '40-timeline-wall',
    tags: ['corporate', 'field', 'timeline', 'planning', 'library'],
  },
  {
    key: 'handshake-lamp',
    file: '41-handshake-lamp',
    tags: ['corporate', 'negotiat', 'deal', 'merger', 'partnership', 'settlement'],
  },
  {
    key: 'empty-podium',
    file: '42-empty-podium',
    tags: ['corporate', 'silence', 'no comment', 'podium', 'resign'],
  },
  {
    key: 'folder-handoff',
    file: '43-folder-handoff',
    tags: ['corporate', 'handover', 'dossier', 'brief', 'procurement', 'tender'],
  },
  {
    key: 'map-table',
    file: '44-map-table',
    tags: [
      'corporate',
      'field',
      'map',
      'region',
      'multi',
      'international',
      'geopolit',
      'escalation',
    ],
  },
  {
    key: 'apology-bow',
    file: '45-apology-bow',
    tags: ['corporate', 'apolog', 'japan', 'korea', 'bow', 'resignation'],
  },
  {
    key: 'tower-storm',
    file: '46-tower-storm',
    tags: ['corporate', 'storm', 'headquarters', 'tower', 'weather', 'typhoon', 'flood'],
  },
  {
    key: 'dawn-after',
    file: '47-dawn-after',
    tags: ['corporate', 'field', 'recovery', 'aftermath', 'dawn'],
  },
  {
    key: 'searchlight',
    file: '48-searchlight',
    tags: [
      'field',
      'default',
      'search',
      'cordon',
      'police',
      'night',
      'shooting',
      'hostage',
      'kidnap',
    ],
  },
  {
    key: 'journalist-night',
    file: '49-journalist-night',
    tags: ['corporate', 'journalist', 'investigat', 'expose', 'reporter'],
  },
  {
    key: 'black-swan',
    file: '50-black-swan',
    tags: ['corporate', 'field', 'default', 'black swan', 'unprecedented', 'unknown'],
  },
];

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export type ArtFamily = 'corporate' | 'field';

export const artFamilyOf = (category: string | null | undefined): ArtFamily =>
  category === 'social_media_crisis' ? 'corporate' : 'field';

/** Path of the chosen scene for a scenario. Stable per id. */
export function artFor(
  s: { id: string; category?: string | null; title?: string | null; description?: string | null },
  size: 'sm' | 'full' = 'sm',
): string {
  const family = artFamilyOf(s.category);
  const text = `${s.title ?? ''} ${s.description ?? ''}`.toLowerCase();
  const eligible = ART_LIBRARY.filter((a) => a.tags.includes(family));

  let best: ArtScene[] = [];
  let bestScore = 0;
  for (const scene of eligible) {
    let score = 0;
    for (const tag of scene.tags) {
      if (tag === 'corporate' || tag === 'field' || tag === 'default') continue;
      if (text.includes(tag)) score += tag.length > 5 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = [scene];
    } else if (score === bestScore && score > 0) {
      best.push(scene);
    }
  }
  if (best.length === 0) best = eligible.filter((a) => a.tags.includes('default'));
  if (best.length === 0) best = eligible;

  const pick = best[hash(s.id) % best.length];
  return artPath(pick.file, size);
}

export const artPath = (file: string, size: 'sm' | 'full' = 'sm'): string =>
  `/marketing/library/${file}${size === 'sm' ? '-sm' : ''}.webp`;

/** Fixed scenes used by the shells (heroes), keyed by surface. */
export const SHELL_ART = {
  warroomEntry: artPath('21-command-post', 'full'),
  fieldIncident: artPath('20-evacuation', 'full'),
  fieldTeams: artPath('22-responders', 'full'),
  fieldScene: artPath('44-map-table', 'full'),
  fieldLocation: artPath('11-border-bridge', 'full'),
  fieldResearch: artPath('09-newsroom', 'full'),
  fieldCompile: artPath('13-debrief', 'full'),
  wizardSetup: artPath('44-map-table', 'full'),
  wizardBuild: artPath('29-clock-pressure', 'full'),
  wizardReview: artPath('13-debrief', 'full'),
  library: artPath('40-timeline-wall', 'full'),
  laneOrgs: artPath('01-war-room', 'sm'),
  lanePressure: artPath('16-protest-lobby', 'sm'),
  laneRivals: artPath('31-headline-storm', 'sm'),
  pathField: artPath('22-responders', 'full'),
  pathCorporate: artPath('01-war-room', 'full'),
} as const;
