import { isKnownCountry } from '@shared/countries';
import type {
  CompetitorDraft,
  OrganisationDraft,
  OrgKind,
  PressureKind,
  PressureOrgDraft,
  RosterEntry,
} from './OrganisationRosterBuilder';

/*
 * Setup checks for the corporate crisis wizard. They mirror the server's validateOrganisations
 * (server/services/scenarioOrgModel.ts) and the request schemas in multiOrgPipeline.ts, so keep
 * them in step with those. Unlike the server, they report every problem at once, each pinned
 * to the field it belongs to.
 */

export const PRESET_TEAM_NAMES = [
  'Communications',
  'Shareholder Engagement',
  'Stakeholder Engagement',
  'Legal',
  'Executive',
];
export const EXECUTIVE_TEAM = 'Executive';
export const PRIMARY_ORG_ID = 'primary';
export const BRIEF_MIN = 50;

const MAX_ORGS = 6;
const MIN_TEAMS = 2;
const MAX_TEAMS = 6;
const NAME_MAX = 120;
const TEAM_NAME_MAX = 60;
/** The server title-cases custom team names and keeps the first 40 characters. */
const TEAM_NAME_KEPT = 40;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 2000;
const CITY_MAX = 80;
const HANDLE_MAX = 60;
const WANTS_MAX = 300;

export type IssueSeverity = 'error' | 'warning';
export type IssueScope = 'brief' | 'org' | 'pressure' | 'rival';

export interface SetupIssue {
  /** `data-field` anchor of the input the note belongs to; null when nothing on the page matches. */
  field: string | null;
  severity: IssueSeverity;
  scope: IssueScope;
  /** Card the field sits on, for the summary list. */
  where: string;
  /** What is wrong and how to fix it. */
  message: string;
}

export interface SetupSnapshot {
  brief: string;
  primary: {
    name: string;
    shortName?: string;
    country: string;
    city: string;
    kind: OrgKind;
    roster: RosterEntry[];
  };
  extras: OrganisationDraft[];
  pressure: PressureOrgDraft[];
  competitors: CompetitorDraft[];
}

type OrgPart = 'name' | 'short_name' | 'country' | 'city' | 'kind' | 'facebook' | 'x' | 'roster';
type TeamPart = 'name' | 'description';
type PressurePart = 'name' | 'country' | 'city' | 'wants';

export const BRIEF_FIELD = 'brief';
export const orgField = (orgId: string, part: OrgPart) => `org:${orgId}:${part}`;
export const teamField = (orgId: string, index: number, part: TeamPart) =>
  `team:${orgId}:${index}:${part}`;
export const pressureField = (id: string, part: PressurePart) => `pressure:${id}:${part}`;
export const competitorField = (index: number) => `competitor:${index}`;

/** Pressure organisations the wizard sends; unnamed drafts stay behind. */
export function isSendablePressureOrg(p: PressureOrgDraft): boolean {
  return p.display_name.trim().length >= 2;
}

/* ─── Collect ──────────────────────────────────────────────────────────── */

const PUBLIC_BODY =
  /\b(ministry|ministries|department|agency|authority|commission|council|bureau|directorate|police|army|navy|air force|coast guard|armed forces|military|command|government|municipal(?:ity)?|embassy|consulate|parliament|kementerian|kementrian|jabatan|dinas|angkatan|polis|polri)\b/i;
const NGO_BODY =
  /\b(foundation|charity|red cross|red crescent|ngo|non-?profit|caritas|oxfam|unicef|unhcr|medecins|médecins)\b/i;

const PRESSURE_KIND_NOUN: Record<PressureKind, string> = {
  regulator: 'regulator',
  union: 'union',
  ngo: 'NGO',
  community_group: 'community group',
  political: 'political actor',
};

function shownTeamName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, TEAM_NAME_KEPT);
}

/** Server function key, lowercased: presets keep their name, custom names keep 40 characters. */
function functionKeyOf(t: RosterEntry): string {
  const raw = t.team_name.trim().replace(/\s+/g, ' ');
  if (!t.is_custom && PRESET_TEAM_NAMES.includes(raw)) return raw.toLowerCase();
  return raw.slice(0, TEAM_NAME_KEPT).toLowerCase();
}

/** Same body written two ways ("Ministry of Labour" / "Ministry of Labour (Malaysia)"). */
function looksLikeSameBody(a: string, b: string): boolean {
  const simplify = (s: string) =>
    s
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const x = simplify(a);
  const y = simplify(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.includes(short);
}

export function collectSetupIssues(s: SetupSnapshot): SetupIssue[] {
  const out: SetupIssue[] = [];
  const error = (field: string | null, where: string, message: string, scope: IssueScope) =>
    out.push({ field, severity: 'error', scope, where, message });
  const warn = (field: string, where: string, message: string, scope: IssueScope) =>
    out.push({ field, severity: 'warning', scope, where, message });

  if (s.brief.length < BRIEF_MIN) {
    error(
      BRIEF_FIELD,
      'Crisis description',
      `Describe the crisis in at least ${BRIEF_MIN} characters (${BRIEF_MIN - s.brief.length} more): what happened, where, and who is affected.`,
      'brief',
    );
  }

  const orgCount = s.extras.length + 1;
  if (orgCount > MAX_ORGS) {
    error(
      null,
      'Organisations',
      `At most ${MAX_ORGS} organisations — remove ${orgCount - MAX_ORGS}.`,
      'org',
    );
  }

  /** Every name taken so far, on any side (the server rejects repeats across all of them). */
  const taken = new Map<string, { label: string; side: 'organisation' | 'pressure group' }>();
  const shortNames = new Map<string, string>();

  const countryCheck = (field: string, country: string, where: string, scope: IssueScope) => {
    if (isKnownCountry(country)) return;
    error(
      field,
      where,
      country.trim()
        ? `"${country}" isn't in the country list — pick the closest match.`
        : 'Pick a country from the list.',
      scope,
    );
  };
  const lengthCheck = (
    field: string,
    value: string,
    max: number,
    what: string,
    where: string,
    scope: IssueScope,
  ) => {
    const n = value.trim().length;
    if (n > max)
      error(field, where, `${what} can be ${max} characters at most — this is ${n}.`, scope);
  };
  const kindCheck = (orgId: string, name: string, kind: OrgKind, where: string) => {
    if (kind !== 'company' && kind !== 'office') return;
    if (PUBLIC_BODY.test(name)) {
      warn(
        orgField(orgId, 'kind'),
        where,
        'This looks like a government body. If it is, set Type to "Government agency" so its people get public-service titles rather than corporate ones.',
        'org',
      );
    } else if (NGO_BODY.test(name)) {
      warn(
        orgField(orgId, 'kind'),
        where,
        'This looks like an NGO. If it is, set Type to "NGO" so its people get fitting titles.',
        'org',
      );
    }
  };

  const rosterCheck = (orgId: string, orgLabel: string, roster: RosterEntry[]) => {
    const rosterKey = orgField(orgId, 'roster');
    const teamsWhere = `${orgLabel} · Teams`;
    if (roster.length < MIN_TEAMS) {
      error(
        rosterKey,
        teamsWhere,
        `Pick at least ${MIN_TEAMS} teams — tick a preset card or add your own (${roster.length} so far).`,
        'org',
      );
    } else if (roster.length > MAX_TEAMS) {
      error(
        rosterKey,
        teamsWhere,
        `At most ${MAX_TEAMS} teams — remove ${roster.length - MAX_TEAMS}.`,
        'org',
      );
    }
    const seen = new Map<string, string>();
    roster.forEach((t, i) => {
      const name = t.team_name.trim();
      const isCustom = t.is_custom || !PRESET_TEAM_NAMES.includes(name);
      const where = `${orgLabel} · ${name || 'New team'}`;
      const nameField = t.is_custom ? teamField(orgId, i, 'name') : rosterKey;
      if (!name) {
        error(
          nameField,
          where,
          'Name this team (e.g. "Franchise Relations"), or remove it.',
          'org',
        );
        return;
      }
      const preset = t.is_custom
        ? PRESET_TEAM_NAMES.find((p) => p.toLowerCase() === name.toLowerCase())
        : undefined;
      const key = functionKeyOf(t);
      const first = seen.get(key);
      if (preset) {
        error(
          nameField,
          where,
          `"${preset}" is a preset team. Tick the ${preset} card above instead, or give yours a different name.`,
          'org',
        );
      } else if (first !== undefined) {
        error(
          nameField,
          where,
          first.toLowerCase() === name.toLowerCase()
            ? `There is already a team called "${first}" — rename or remove one.`
            : `This and "${first}" share their first ${TEAM_NAME_KEPT} characters, so both would be called "${shownTeamName(name)}" — make them differ sooner.`,
          'org',
        );
      } else if (name.length > TEAM_NAME_MAX) {
        error(
          nameField,
          where,
          `Team names can be ${TEAM_NAME_MAX} characters at most — this is ${name.length}.`,
          'org',
        );
      } else if (isCustom && name.length > TEAM_NAME_KEPT) {
        warn(
          nameField,
          where,
          `Names are cut to ${TEAM_NAME_KEPT} characters, so this team will show as "${shownTeamName(name)}".`,
          'org',
        );
      }
      if (first === undefined && !preset) seen.set(key, name);
      if (isCustom) {
        const descField = t.is_custom ? teamField(orgId, i, 'description') : rosterKey;
        const d = t.description.trim();
        if (d.length < DESCRIPTION_MIN) {
          error(
            descField,
            where,
            `Say what this team does in a sentence (at least ${DESCRIPTION_MIN} characters). Its injects, contacts and scoring are built from it.`,
            'org',
          );
        } else if (d.length > DESCRIPTION_MAX) {
          error(
            descField,
            where,
            `Keep the description under ${DESCRIPTION_MAX.toLocaleString()} characters — this is ${d.length.toLocaleString()}.`,
            'org',
          );
        }
      }
    });
    const voices = roster.filter((t) => t.is_public_voice).length;
    if (roster.length > 0 && voices === 0) {
      error(
        rosterKey,
        teamsWhere,
        'Choose the team that speaks publicly: press "○ Public voice" on it.',
        'org',
      );
    } else if (voices > 1) {
      error(
        rosterKey,
        teamsWhere,
        `${voices} teams are marked as the public voice — keep it on one.`,
        'org',
      );
    }
  };

  /* Primary organisation (headquarters) */
  const primaryName = s.primary.name.trim();
  const primaryLabel = primaryName || 'Headquarters';
  if (s.extras.length > 0 && primaryName.length < 2) {
    error(
      orgField(PRIMARY_ORG_ID, 'name'),
      primaryLabel,
      'Name your organisation — needed when several organisations take part.',
      'org',
    );
  } else {
    lengthCheck(
      orgField(PRIMARY_ORG_ID, 'name'),
      primaryName,
      NAME_MAX,
      'Organisation names',
      primaryLabel,
      'org',
    );
  }
  // The wizard sends "Organisation" when the name is left to the AI.
  taken.set((primaryName || 'Organisation').toLowerCase(), {
    label: primaryLabel,
    side: 'organisation',
  });
  const primaryShort = s.primary.shortName?.trim();
  if (primaryShort) shortNames.set(primaryShort.toLowerCase(), primaryLabel);
  countryCheck(orgField(PRIMARY_ORG_ID, 'country'), s.primary.country, primaryLabel, 'org');
  lengthCheck(
    orgField(PRIMARY_ORG_ID, 'city'),
    s.primary.city,
    CITY_MAX,
    'City',
    primaryLabel,
    'org',
  );
  kindCheck(PRIMARY_ORG_ID, primaryName, s.primary.kind, primaryLabel);
  rosterCheck(PRIMARY_ORG_ID, primaryLabel, s.primary.roster);

  /* Additional organisations */
  s.extras.forEach((o, i) => {
    const name = o.display_name.trim();
    const label = name || `Organisation ${i + 2}`;
    const nameField = orgField(o.id, 'name');
    const owner = taken.get(name.toLowerCase());
    if (name.length < 2) {
      error(
        nameField,
        label,
        'Name this organisation (at least 2 characters), e.g. "National Bureau of Investigation".',
        'org',
      );
    } else if (name.length > NAME_MAX) {
      lengthCheck(nameField, name, NAME_MAX, 'Organisation names', label, 'org');
    } else if (owner) {
      error(
        nameField,
        label,
        `${owner.label === name ? 'Another organisation' : owner.label} already uses this name — add the country or city to tell them apart.`,
        'org',
      );
    } else {
      taken.set(name.toLowerCase(), { label, side: 'organisation' });
    }
    const short = o.short_name.trim();
    if (short) {
      const shortOwner = shortNames.get(short.toLowerCase());
      if (shortOwner) {
        error(
          orgField(o.id, 'short_name'),
          label,
          `${shortOwner} already uses the short name "${short}". Team names are built from it, so pick another.`,
          'org',
        );
      } else {
        shortNames.set(short.toLowerCase(), label);
      }
    }
    countryCheck(orgField(o.id, 'country'), o.country, label, 'org');
    lengthCheck(orgField(o.id, 'city'), o.city, CITY_MAX, 'City', label, 'org');
    kindCheck(o.id, name, o.kind, label);
    lengthCheck(orgField(o.id, 'facebook'), o.facebook_handle, HANDLE_MAX, 'Handles', label, 'org');
    lengthCheck(orgField(o.id, 'x'), o.x_handle, HANDLE_MAX, 'Handles', label, 'org');
    rosterCheck(o.id, label, o.team_roster);
  });

  /* Pressure groups */
  const pressureSeen: PressureOrgDraft[] = [];
  s.pressure.forEach((p, i) => {
    const name = p.display_name.trim();
    const label = name || `Pressure group ${i + 1}`;
    const nameField = pressureField(p.id, 'name');
    const owner = taken.get(name.toLowerCase());
    if (name.length < 2) {
      error(
        nameField,
        label,
        'Name this pressure group (e.g. "Ministry of Human Resources"), or remove the card.',
        'pressure',
      );
    } else if (name.length > NAME_MAX) {
      lengthCheck(nameField, name, NAME_MAX, 'Names', label, 'pressure');
    } else if (owner) {
      error(
        nameField,
        label,
        owner.side === 'organisation'
          ? `${owner.label === name ? 'One of your organisations' : owner.label} already uses this name — every organisation and group needs its own.`
          : 'Another pressure group already uses this name — rename or remove one.',
        'pressure',
      );
    } else {
      taken.set(name.toLowerCase(), { label, side: 'pressure group' });
      const twin = pressureSeen.find(
        (q) => q.country === p.country && looksLikeSameBody(q.display_name, name),
      );
      const sameKind = pressureSeen.find(
        (q) =>
          q.country === p.country &&
          q.kind === p.kind &&
          (p.kind === 'regulator' || p.kind === 'union'),
      );
      if (twin) {
        warn(
          nameField,
          label,
          `Looks like the same body as "${twin.display_name.trim()}". If it is, remove one.`,
          'pressure',
        );
      } else if (sameKind) {
        warn(
          nameField,
          label,
          `"${sameKind.display_name.trim()}" is also a ${PRESSURE_KIND_NOUN[p.kind]} in ${p.country}. If they're the same body, remove one; if not, ignore this.`,
          'pressure',
        );
      }
      pressureSeen.push(p);
    }
    countryCheck(pressureField(p.id, 'country'), p.country, label, 'pressure');
    lengthCheck(pressureField(p.id, 'city'), p.city, CITY_MAX, 'City', label, 'pressure');
    const wants = p.wants.trim();
    if (wants.length > WANTS_MAX) {
      error(
        pressureField(p.id, 'wants'),
        label,
        `Keep the demand to a sentence — ${WANTS_MAX} characters at most (this is ${wants.length}).`,
        'pressure',
      );
    }
  });

  /* Rival pages (added through the form, so a bad one is removed and re-added) */
  const rivals = new Set<string>();
  s.competitors.forEach((c, i) => {
    const name = c.name.trim();
    const label = name || `Rival ${i + 1}`;
    const field = competitorField(i);
    if (name.length < 2) {
      error(
        field,
        label,
        'Rival names need at least 2 characters — remove this one and add it again.',
        'rival',
      );
    } else if (name.length > NAME_MAX) {
      error(
        field,
        label,
        `Rival names can be ${NAME_MAX} characters at most — remove this one and add it again with a shorter name.`,
        'rival',
      );
    }
    if (!isKnownCountry(c.country)) {
      error(
        field,
        label,
        'Its country isn\u2019t in the list — remove this rival and add it again with a country from the list.',
        'rival',
      );
    }
    if (
      (c.facebook_handle ?? '').trim().length > HANDLE_MAX ||
      (c.x_handle ?? '').trim().length > HANDLE_MAX
    ) {
      error(
        field,
        label,
        `Handles can be ${HANDLE_MAX} characters at most — remove this rival and add it again.`,
        'rival',
      );
    }
    if (name.length >= 2) {
      const lower = name.toLowerCase();
      const owner = taken.get(lower);
      if (rivals.has(lower)) {
        warn(field, label, 'This rival is listed twice — remove one.', 'rival');
      } else if (owner) {
        warn(
          field,
          label,
          `"${name}" is also listed as ${owner.side === 'organisation' ? 'one of your organisations' : 'a pressure group'} — remove it from whichever side is wrong.`,
          'rival',
        );
      }
      rivals.add(lower);
    }
  });

  return out;
}

/* ─── Lookup ───────────────────────────────────────────────────────────── */

export function indexIssues(issues: SetupIssue[]): Map<string, SetupIssue[]> {
  const byField = new Map<string, SetupIssue[]>();
  for (const issue of issues) {
    if (!issue.field) continue;
    const list = byField.get(issue.field);
    if (list) list.push(issue);
    else byField.set(issue.field, [issue]);
  }
  return byField;
}

/** The note a field shows: its first error once errors are revealed, otherwise its first warning. */
export function pickIssue(list: SetupIssue[] | undefined, reveal: boolean): SetupIssue | null {
  if (!list) return null;
  return (
    (reveal ? list.find((i) => i.severity === 'error') : undefined) ??
    list.find((i) => i.severity === 'warning') ??
    null
  );
}

/* ─── Server refusals ──────────────────────────────────────────────────── */

interface ServerDetail {
  field?: unknown;
  path?: unknown;
  code?: unknown;
  message?: unknown;
}

const ZOD_ORG_PARTS: Record<string, OrgPart> = {
  display_name: 'name',
  short_name: 'short_name',
  country: 'country',
  city: 'city',
  kind: 'kind',
  facebook_handle: 'facebook',
  x_handle: 'x',
  team_roster: 'roster',
};

function friendlyZodMessage(message: string): string {
  const most = /(?:at most|<=)\s*(\d+)\s*character/i.exec(message);
  if (most) return `Too long — ${most[1]} characters at most.`;
  const least = /(?:at least|>=)\s*(\d+)\s*character/i.exec(message);
  if (least) return least[1] === '1' ? 'Required.' : `Too short — at least ${least[1]} characters.`;
  return message;
}

/**
 * Pins a 400 from a generation endpoint onto Setup fields. Handles both shapes: request-schema
 * failures (`details[].field` = "body.organisations.1.team_roster.2.team_name") and
 * validateOrganisations failures (`details[].path` = "organisations.<name>.team_roster.<team>").
 * Returns [] when the body carries no details.
 */
export function issuesFromServer(body: unknown, s: SetupSnapshot): SetupIssue[] {
  if (!body || typeof body !== 'object') return [];
  const details = (body as { details?: unknown }).details;
  if (!Array.isArray(details) || details.length === 0) return [];

  const orgs = [
    {
      id: PRIMARY_ORG_ID,
      sentName: s.primary.name.trim() || 'Organisation',
      label: s.primary.name.trim() || 'Headquarters',
      roster: s.primary.roster,
    },
    ...s.extras.map((o, i) => ({
      id: o.id,
      sentName: o.display_name.trim(),
      label: o.display_name.trim() || `Organisation ${i + 2}`,
      roster: o.team_roster,
    })),
  ];
  const sentPressure = s.pressure.filter(isSendablePressureOrg);
  const issue = (
    field: string | null,
    where: string,
    message: string,
    scope: IssueScope = 'org',
  ): SetupIssue => ({ field, severity: 'error', scope, where, message });

  const teamIssue = (
    org: (typeof orgs)[number],
    index: number,
    part: TeamPart,
    message: string,
  ): SetupIssue => {
    const team = org.roster[index];
    return issue(
      team?.is_custom ? teamField(org.id, index, part) : orgField(org.id, 'roster'),
      `${org.label} · ${team?.team_name.trim() || 'Teams'}`,
      message,
    );
  };

  const fromSchemaPath = (path: string, message: string): SetupIssue => {
    const [head, index, prop, teamIndex, teamProp] = path.split('.');
    const i = Number(index);
    if (head === 'organisations' && orgs[i]) {
      const org = orgs[i];
      if (prop === 'team_roster' && teamIndex !== undefined && /^\d+$/.test(teamIndex)) {
        return teamIssue(
          org,
          Number(teamIndex),
          teamProp === 'description' ? 'description' : 'name',
          message,
        );
      }
      const part = ZOD_ORG_PARTS[prop ?? ''];
      return issue(part ? orgField(org.id, part) : null, org.label, message);
    }
    if (head === 'pressure_organisations' && sentPressure[i]) {
      const p = sentPressure[i];
      const part: PressurePart =
        prop === 'country' || prop === 'city' || prop === 'wants' ? prop : 'name';
      return issue(pressureField(p.id, part), p.display_name.trim(), message, 'pressure');
    }
    if (head === 'competitors' && s.competitors[i]) {
      return issue(
        competitorField(i),
        s.competitors[i].name.trim() || `Rival ${i + 1}`,
        message,
        'rival',
      );
    }
    return issue(null, 'Setup', message);
  };

  const fromRulePath = (path: string, code: string, message: string): SetupIssue => {
    if (path.startsWith('organisations.')) {
      const rest = path.slice('organisations.'.length);
      const org = [...orgs]
        .sort((a, b) => b.sentName.length - a.sentName.length)
        .find((o) => {
          const name = o.sentName || '?';
          return rest === name || rest.startsWith(`${name}.team_roster`);
        });
      if (org) {
        const after = rest.slice((org.sentName || '?').length);
        if (after.startsWith('.team_roster.')) {
          const teamName = after.slice('.team_roster.'.length);
          let index = org.roster.findIndex((t) => t.team_name.trim() === teamName);
          if (index < 0)
            index = org.roster.findIndex(
              (t) => t.team_name.trim().toLowerCase() === teamName.toLowerCase(),
            );
          if (index >= 0)
            return teamIssue(org, index, code === 'MO-TEAM-005' ? 'description' : 'name', message);
        }
        if (after.startsWith('.team_roster'))
          return issue(orgField(org.id, 'roster'), `${org.label} · Teams`, message);
        return issue(
          orgField(org.id, code === 'MO-ORG-004' ? 'country' : 'name'),
          org.label,
          message,
        );
      }
    }
    if (path.startsWith('pressure_organisations.')) {
      const key = path.slice('pressure_organisations.'.length);
      const p =
        sentPressure.find((q) => q.display_name.trim() === key) ??
        (/^\d+$/.test(key) ? sentPressure[Number(key)] : undefined);
      if (p) {
        return issue(
          pressureField(p.id, /unknown country/i.test(message) ? 'country' : 'name'),
          p.display_name.trim(),
          message,
          'pressure',
        );
      }
    }
    const rival = /^competitors\.(\d+)$/.exec(path);
    if (rival && s.competitors[Number(rival[1])]) {
      const i = Number(rival[1]);
      return issue(
        competitorField(i),
        s.competitors[i].name.trim() || `Rival ${i + 1}`,
        message,
        'rival',
      );
    }
    return issue(null, 'Setup', message);
  };

  return (details as ServerDetail[]).map((d) => {
    const message = typeof d.message === 'string' && d.message ? d.message : 'Not accepted';
    if (typeof d.field === 'string' && d.field) {
      return fromSchemaPath(d.field.replace(/^body\./, ''), friendlyZodMessage(message));
    }
    return fromRulePath(
      typeof d.path === 'string' ? d.path : '',
      typeof d.code === 'string' ? d.code : '',
      message,
    );
  });
}
