import { COUNTRIES, isKnownCountry } from '@shared/countries';

/* ─── Types (mirror server OrganisationInput / RosterEntryInput) ────────── */

/** A team the trainer picked for an organisation: preset function or their own division. */
export interface RosterEntry {
  team_name: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
}

export interface PresetTeamCard {
  team_name: string;
  mission: string;
  responsibilities: string[];
  default_public_voice: boolean;
  is_executive?: boolean;
}

export type OrgKind = 'company' | 'office' | 'agency' | 'ngo' | 'other';

/** An additional protagonist organisation (the primary lives in the wizard's legacy fields). */
export interface OrganisationDraft {
  id: string;
  display_name: string;
  short_name: string;
  country: string;
  city: string;
  kind: OrgKind;
  facebook_handle: string;
  x_handle: string;
  team_roster: RosterEntry[];
}

export interface CompetitorDraft {
  name: string;
  country: string;
  facebook_handle?: string;
  x_handle?: string;
}

export const PRESET_TEAM_NAMES = [
  'Communications',
  'Shareholder Engagement',
  'Stakeholder Engagement',
  'Legal',
  'Executive',
];
/** Retired preset names — legacy drafts resume with them mapped to the current presets. */
export const LEGACY_PRESET_ALIASES: Record<string, string> = {
  Procurement: 'Shareholder Engagement',
  Sales: 'Stakeholder Engagement',
};

/** Rename retired preset entries in a saved roster (custom teams are left untouched). */
export function migrateLegacyRoster(roster: RosterEntry[]): RosterEntry[] {
  const seen = new Set<string>();
  const out: RosterEntry[] = [];
  for (const t of roster) {
    const name =
      !t.is_custom && LEGACY_PRESET_ALIASES[t.team_name]
        ? LEGACY_PRESET_ALIASES[t.team_name]
        : t.team_name;
    if (!t.is_custom && seen.has(name)) continue; // two retired names mapping to one preset
    seen.add(name);
    out.push({ ...t, team_name: name });
  }
  return out;
}
export const EXECUTIVE_TEAM = 'Executive';

export const DEFAULT_TEAM_ROSTER: RosterEntry[] = [
  'Communications',
  'Shareholder Engagement',
  'Stakeholder Engagement',
  'Legal',
].map((n) => ({
  team_name: n,
  description: '',
  is_custom: false,
  is_public_voice: n === 'Communications',
}));

export const ORG_KIND_LABELS: Record<OrgKind, string> = {
  company: 'Company',
  office: 'Office / subsidiary',
  agency: 'Government agency',
  ngo: 'NGO',
  other: 'Other',
};

export function newOrganisationDraft(country: string): OrganisationDraft {
  return {
    id: `org_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    display_name: '',
    short_name: '',
    country,
    city: '',
    kind: 'company',
    facebook_handle: '',
    x_handle: '',
    team_roster: DEFAULT_TEAM_ROSTER.map((t) => ({ ...t })),
  };
}

/* ─── Validation (mirrors server validateOrganisations; server still enforces) ── */

export function rosterErrorFor(roster: RosterEntry[], orgLabel?: string): string | null {
  const prefix = orgLabel ? `${orgLabel}: ` : '';
  if (roster.length < 2) return `${prefix}Pick at least 2 teams`;
  if (roster.length > 6) return `${prefix}Maximum 6 teams`;
  const names = roster.map((t) => t.team_name.trim().toLowerCase());
  if (names.some((n) => !n)) return `${prefix}Every custom team needs a name`;
  if (new Set(names).size !== names.length) return `${prefix}Team names must be unique`;
  const clash = roster.find(
    (t) =>
      t.is_custom &&
      PRESET_TEAM_NAMES.some((p) => p.toLowerCase() === t.team_name.trim().toLowerCase()),
  );
  if (clash) return `${prefix}"${clash.team_name}" is a preset name — rename the custom team`;
  const bad = roster.find((t) => t.is_custom && t.description.trim().length < 10);
  if (bad)
    return `${prefix}Describe what "${bad.team_name || 'your custom team'}" does (min 10 characters)`;
  if (roster.filter((t) => t.team_name === EXECUTIVE_TEAM && !t.is_custom).length > 1)
    return `${prefix}Only one Executive team`;
  if (roster.filter((t) => t.is_public_voice).length !== 1)
    return `${prefix}Tick exactly one team as the public voice`;
  return null;
}

export function organisationsErrorFor(
  primary: { display_name: string; country: string; team_roster: RosterEntry[] },
  extras: OrganisationDraft[],
  competitors: CompetitorDraft[],
): string | null {
  if (extras.length + 1 > 6) return 'Maximum 6 organisations';
  if (!isKnownCountry(primary.country))
    return 'Pick the primary organisation\u2019s country from the list';
  const primaryErr = rosterErrorFor(
    primary.team_roster,
    extras.length > 0 ? primary.display_name || 'Primary organisation' : undefined,
  );
  if (primaryErr) return primaryErr;
  if (extras.length > 0 && primary.display_name.trim().length < 2)
    return 'Name the primary organisation (needed when there are several organisations)';
  const names = new Set([primary.display_name.trim().toLowerCase()]);
  for (const o of extras) {
    const label = o.display_name.trim() || 'Unnamed organisation';
    if (o.display_name.trim().length < 2) return 'Every organisation needs a name (2+ characters)';
    if (names.has(o.display_name.trim().toLowerCase()))
      return `Organisation names must be unique: "${label}"`;
    names.add(o.display_name.trim().toLowerCase());
    if (!isKnownCountry(o.country)) return `${label}: pick a country from the list`;
    const err = rosterErrorFor(o.team_roster, label);
    if (err) return err;
  }
  for (const c of competitors) {
    if (c.name.trim().length < 2) return 'Every competitor needs a name';
    if (!isKnownCountry(c.country)) return `Competitor "${c.name}": pick a country from the list`;
  }
  return null;
}

/** Keep exactly one public voice whenever possible (Communications first, then the first non-Executive). */
export function withOnePublicVoice(next: RosterEntry[]): RosterEntry[] {
  if (next.length === 0 || next.some((t) => t.is_public_voice)) return next;
  const comms = next.find((t) => t.team_name === 'Communications');
  const fallback = comms ?? next.find((t) => t.team_name !== EXECUTIVE_TEAM) ?? next[0];
  return next.map((t) => (t === fallback ? { ...t, is_public_voice: true } : t));
}

/* ─── Country select ─────────────────────────────────────────────────────── */

export function CountrySelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const known = isKnownCountry(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        className ||
        'w-full bg-surface border border-border px-3 py-2 text-sm terminal-text text-ink focus:border-accent focus:outline-none'
      }
    >
      {!known && value && <option value={value}>{value} (not in list)</option>}
      {!value && <option value="">Select a country…</option>}
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/* ─── Roster builder ─────────────────────────────────────────────────────── */

export function RosterBuilder({
  roster,
  onChange,
  presetCatalog,
  compact,
}: {
  roster: RosterEntry[];
  onChange: (next: RosterEntry[]) => void;
  presetCatalog: PresetTeamCard[];
  compact?: boolean;
}) {
  const presets: PresetTeamCard[] =
    presetCatalog.length > 0
      ? presetCatalog
      : PRESET_TEAM_NAMES.map((n) => ({
          team_name: n,
          mission: '',
          responsibilities: [],
          default_public_voice: n === 'Communications',
          is_executive: n === EXECUTIVE_TEAM,
        }));

  const setPublicVoice = (teamName: string) =>
    onChange(roster.map((t) => ({ ...t, is_public_voice: t.team_name === teamName })));

  const togglePreset = (preset: PresetTeamCard) => {
    const exists = roster.some((t) => !t.is_custom && t.team_name === preset.team_name);
    const next = exists
      ? roster.filter((t) => t.is_custom || t.team_name !== preset.team_name)
      : [
          ...roster,
          {
            team_name: preset.team_name,
            description: '',
            is_custom: false,
            is_public_voice: false,
          },
        ];
    onChange(withOnePublicVoice(next));
  };

  const error = rosterErrorFor(roster);

  return (
    <div>
      <div
        className={`grid grid-cols-1 ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-2 mb-3`}
      >
        {presets.map((preset) => {
          const entry = roster.find((t) => !t.is_custom && t.team_name === preset.team_name);
          const selected = !!entry;
          return (
            <div
              key={preset.team_name}
              className={`border rounded p-2.5 cursor-pointer transition-colors ${
                selected ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'
              }`}
              onClick={() => togglePreset(preset)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs terminal-text text-ink font-bold">
                  {selected ? '☑' : '☐'} {preset.team_name}
                  {preset.is_executive && (
                    <span className="ml-1 text-[9px] terminal-text text-warning border border-warning/40 rounded px-1">
                      leadership
                    </span>
                  )}
                </span>
                {selected && (
                  <label
                    className={`text-[9px] terminal-text cursor-pointer px-1.5 py-0.5 rounded border whitespace-nowrap ${
                      entry!.is_public_voice
                        ? 'border-accent text-accent'
                        : 'border-border text-muted hover:text-ink'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPublicVoice(preset.team_name);
                    }}
                  >
                    {entry!.is_public_voice ? '◉ Public voice' : '○ Public voice'}
                  </label>
                )}
              </div>
              {preset.mission && !compact && (
                <div className="text-[10px] terminal-text text-muted mt-1 leading-relaxed line-clamp-2">
                  {preset.mission}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {roster.some((t) => t.is_custom) && (
        <div className="space-y-2 mb-3">
          {roster.map((t, idx) =>
            t.is_custom ? (
              <div key={idx} className="border border-border rounded p-2.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <input
                    value={t.team_name}
                    onChange={(e) =>
                      onChange(
                        roster.map((x, i) => (i === idx ? { ...x, team_name: e.target.value } : x)),
                      )
                    }
                    placeholder="Team name (e.g. Franchise Relations)"
                    className="flex-1 bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded"
                  />
                  <label
                    className={`text-[9px] terminal-text cursor-pointer px-1.5 py-0.5 rounded border whitespace-nowrap ${
                      t.is_public_voice
                        ? 'border-accent text-accent'
                        : 'border-border text-muted hover:text-ink'
                    }`}
                    onClick={() => setPublicVoice(t.team_name)}
                  >
                    {t.is_public_voice ? '◉ Public voice' : '○ Public voice'}
                  </label>
                  <button
                    onClick={() => onChange(withOnePublicVoice(roster.filter((_, i) => i !== idx)))}
                    className="text-[10px] terminal-text text-danger hover:opacity-80 border border-danger/30 px-2 py-0.5 rounded"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={t.description}
                  onChange={(e) =>
                    onChange(
                      roster.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)),
                    )
                  }
                  rows={2}
                  placeholder="What does this team do? (feeds the AI: their injects, pressure, duties, contacts and scoring are built from this)"
                  className="w-full bg-surface border border-border text-ink terminal-text text-[11px] px-2 py-1 rounded resize-y"
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() =>
            roster.length < 6 &&
            onChange([
              ...roster,
              { team_name: '', description: '', is_custom: true, is_public_voice: false },
            ])
          }
          disabled={roster.length >= 6}
          className="text-[10px] terminal-text text-accent hover:opacity-80 border border-accent/30 px-2 py-1 rounded disabled:opacity-40"
        >
          + Add your own team
        </button>
        <span className="text-[10px] terminal-text text-muted">{roster.length}/6 teams</span>
      </div>

      {error && <div className="mt-2 text-[10px] terminal-text text-warning">{error}</div>}
    </div>
  );
}

/* ─── Additional organisation card ───────────────────────────────────────── */

export function OrganisationCard({
  org,
  index,
  onChange,
  onRemove,
  presetCatalog,
}: {
  org: OrganisationDraft;
  index: number;
  onChange: (next: OrganisationDraft) => void;
  onRemove: () => void;
  presetCatalog: PresetTeamCard[];
}) {
  const field =
    'bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded w-full';
  return (
    <div className="border border-border rounded p-3 bg-surface">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs terminal-text text-ink font-bold">
          Organisation {index + 2}
          {org.display_name.trim() ? ` — ${org.display_name.trim()}` : ''}
        </span>
        <button
          onClick={onRemove}
          className="text-[10px] terminal-text text-danger hover:opacity-80 border border-danger/30 px-2 py-0.5 rounded"
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
        <input
          value={org.display_name}
          onChange={(e) => onChange({ ...org, display_name: e.target.value })}
          placeholder="Organisation name (e.g. National Bureau of Investigation)"
          className={`${field} sm:col-span-2`}
        />
        <input
          value={org.short_name}
          onChange={(e) => onChange({ ...org, short_name: e.target.value.slice(0, 20) })}
          placeholder="Short name (e.g. NBI) — optional"
          className={field}
        />
        <CountrySelect
          value={org.country}
          onChange={(v) => onChange({ ...org, country: v })}
          className={field}
        />
        <input
          value={org.city}
          onChange={(e) => onChange({ ...org, city: e.target.value })}
          placeholder="City (optional)"
          className={field}
        />
        <select
          value={org.kind}
          onChange={(e) => onChange({ ...org, kind: e.target.value as OrgKind })}
          className={field}
        >
          {(Object.keys(ORG_KIND_LABELS) as OrgKind[]).map((k) => (
            <option key={k} value={k}>
              {ORG_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <input
          value={org.facebook_handle}
          onChange={(e) => onChange({ ...org, facebook_handle: e.target.value })}
          placeholder="@FacebookHandle (optional)"
          className={field}
        />
        <input
          value={org.x_handle}
          onChange={(e) => onChange({ ...org, x_handle: e.target.value })}
          placeholder="@XHandle (optional)"
          className={field}
        />
      </div>
      <div className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-1">
        Teams at this organisation
      </div>
      <RosterBuilder
        roster={org.team_roster}
        onChange={(next) => onChange({ ...org, team_roster: next })}
        presetCatalog={presetCatalog}
        compact
      />
    </div>
  );
}
