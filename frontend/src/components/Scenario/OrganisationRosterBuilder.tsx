import { COUNTRIES, isKnownCountry } from '@shared/countries';
import { FieldNote, issueClass, useIssueLookup } from './SetupIssues';
import {
  EXECUTIVE_TEAM,
  PRESET_TEAM_NAMES,
  PRIMARY_ORG_ID,
  orgField,
  pressureField,
  teamField,
} from './setupValidation';

export { EXECUTIVE_TEAM, PRESET_TEAM_NAMES };

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
  /** 'ai' = nobody plays this office; page + carriers are simulated (pressure plan §12). */
  operation?: 'players' | 'ai';
  /** Set when the footprint inference proposed this organisation. */
  proposed_reason?: string;
}

export interface CompetitorDraft {
  name: string;
  country: string;
  facebook_handle?: string;
  x_handle?: string;
}

/* ─── Pressure organisations (pressure plan §5.1 / §11) ──────────────────── */

export type PressureKind = 'union' | 'regulator' | 'ngo' | 'community_group' | 'political';
export type PressureRegister = 'statutory' | 'advocacy' | 'grassroots' | 'political';

export interface PressureOrgDraft {
  id: string;
  org_key?: string;
  display_name: string;
  kind: PressureKind;
  country: string;
  city: string;
  register: PressureRegister;
  wants: string;
  facebook_handle: string;
  x_handle: string;
  spokesperson_stakeholder_id?: string;
  proposed_reason?: string;
}

export const PRESSURE_KIND_LABELS: Record<PressureKind, string> = {
  regulator: 'Regulator / ministry',
  union: 'Union / labour body',
  ngo: 'NGO / advocacy group',
  community_group: 'Community group',
  political: 'Political actor',
};

export const PRESSURE_REGISTER_LABELS: Record<PressureRegister, string> = {
  statutory: 'Statutory (formal, procedural)',
  advocacy: 'Advocacy (members / victims first)',
  grassroots: 'Grassroots (local, organising)',
  political: 'Political (accountability, inquiries)',
};

export function defaultRegisterFor(kind: PressureKind): PressureRegister {
  return kind === 'regulator'
    ? 'statutory'
    : kind === 'community_group'
      ? 'grassroots'
      : kind === 'political'
        ? 'political'
        : 'advocacy';
}

export function newPressureOrgDraft(
  country: string,
  kind: PressureKind = 'regulator',
): PressureOrgDraft {
  return {
    id: `prs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    display_name: '',
    kind,
    country,
    city: '',
    register: defaultRegisterFor(kind),
    wants: '',
    facebook_handle: '',
    x_handle: '',
  };
}

export function PressureOrgCard({
  org,
  onChange,
  onRemove,
}: {
  org: PressureOrgDraft;
  onChange: (next: PressureOrgDraft) => void;
  onRemove: () => void;
}) {
  const field =
    'bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded w-full';
  const issueAt = useIssueLookup();
  const nameIssue = issueAt(pressureField(org.id, 'name'));
  const countryIssue = issueAt(pressureField(org.id, 'country'));
  const cityIssue = issueAt(pressureField(org.id, 'city'));
  const wantsIssue = issueAt(pressureField(org.id, 'wants'));
  return (
    <div className="border border-warning/30 rounded p-3 bg-surface">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] terminal-text text-warning uppercase tracking-wider">
          Pressure organisation · {PRESSURE_KIND_LABELS[org.kind]}
          {org.spokesperson_stakeholder_id && (
            <span className="ml-2 text-muted normal-case">spokesperson linked</span>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] terminal-text text-danger hover:opacity-80 border border-danger/30 px-2 py-0.5 rounded"
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
        <div className="sm:col-span-2" data-field={pressureField(org.id, 'name')}>
          <input
            value={org.display_name}
            onChange={(e) => onChange({ ...org, display_name: e.target.value })}
            placeholder="Full official name (e.g. Ministry of Human Resources)"
            className={`${field} ${issueClass(nameIssue)}`}
            aria-invalid={nameIssue?.severity === 'error' || undefined}
          />
          <FieldNote issue={nameIssue} />
        </div>
        <select
          value={org.kind}
          onChange={(e) => {
            const kind = e.target.value as PressureKind;
            onChange({ ...org, kind, register: defaultRegisterFor(kind) });
          }}
          className={`${field} self-start`}
        >
          {(Object.keys(PRESSURE_KIND_LABELS) as PressureKind[]).map((k) => (
            <option key={k} value={k}>
              {PRESSURE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <div data-field={pressureField(org.id, 'country')}>
          <select
            value={org.country}
            onChange={(e) => onChange({ ...org, country: e.target.value })}
            className={`${field} ${issueClass(countryIssue)}`}
            aria-invalid={countryIssue?.severity === 'error' || undefined}
          >
            {!isKnownCountry(org.country) && (
              <option value={org.country}>
                {org.country ? `${org.country} (not in list)` : 'Select a country…'}
              </option>
            )}
            {COUNTRIES.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <FieldNote issue={countryIssue} />
        </div>
        <div data-field={pressureField(org.id, 'city')}>
          <input
            value={org.city}
            onChange={(e) => onChange({ ...org, city: e.target.value })}
            placeholder="City (optional)"
            className={`${field} ${issueClass(cityIssue)}`}
            aria-invalid={cityIssue?.severity === 'error' || undefined}
          />
          <FieldNote issue={cityIssue} />
        </div>
        <select
          value={org.register}
          onChange={(e) => onChange({ ...org, register: e.target.value as PressureRegister })}
          className={`${field} self-start`}
        >
          {(Object.keys(PRESSURE_REGISTER_LABELS) as PressureRegister[]).map((r) => (
            <option key={r} value={r}>
              {PRESSURE_REGISTER_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-1" data-field={pressureField(org.id, 'wants')}>
        <input
          value={org.wants}
          onChange={(e) => onChange({ ...org, wants: e.target.value })}
          placeholder="What they demand (one sentence, optional — the War Room infers it otherwise)"
          className={`${field} ${issueClass(wantsIssue)}`}
          aria-invalid={wantsIssue?.severity === 'error' || undefined}
        />
        <FieldNote issue={wantsIssue} />
      </div>
      {org.proposed_reason && (
        <div className="text-[10px] terminal-text text-accent">
          Suggested from your description: {org.proposed_reason}
        </div>
      )}
    </div>
  );
}

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
  orgId = PRIMARY_ORG_ID,
}: {
  roster: RosterEntry[];
  onChange: (next: RosterEntry[]) => void;
  presetCatalog: PresetTeamCard[];
  compact?: boolean;
  /** Owner of the roster, for Setup issue anchors. */
  orgId?: string;
}) {
  const issueAt = useIssueLookup();
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

  const rosterIssue = issueAt(orgField(orgId, 'roster'));

  return (
    <div data-field={orgField(orgId, 'roster')}>
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
          {roster.map((t, idx) => {
            if (!t.is_custom) return null;
            const nameIssue = issueAt(teamField(orgId, idx, 'name'));
            const descIssue = issueAt(teamField(orgId, idx, 'description'));
            return (
              <div key={idx} className="border border-border rounded p-2.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="flex-1 min-w-0" data-field={teamField(orgId, idx, 'name')}>
                    <input
                      value={t.team_name}
                      onChange={(e) =>
                        onChange(
                          roster.map((x, i) =>
                            i === idx ? { ...x, team_name: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="Team name (e.g. Franchise Relations)"
                      className={`w-full bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded ${issueClass(nameIssue)}`}
                      aria-invalid={nameIssue?.severity === 'error' || undefined}
                    />
                  </div>
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
                {nameIssue && (
                  <div className="-mt-0.5 mb-1.5">
                    <FieldNote issue={nameIssue} />
                  </div>
                )}
                <div data-field={teamField(orgId, idx, 'description')}>
                  <textarea
                    value={t.description}
                    onChange={(e) =>
                      onChange(
                        roster.map((x, i) =>
                          i === idx ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                    rows={2}
                    placeholder="What does this team do? (feeds the AI: their injects, pressure, duties, contacts and scoring are built from this)"
                    className={`w-full bg-surface border border-border text-ink terminal-text text-[11px] px-2 py-1 rounded resize-y ${issueClass(descIssue)}`}
                    aria-invalid={descIssue?.severity === 'error' || undefined}
                  />
                  <FieldNote issue={descIssue} />
                </div>
              </div>
            );
          })}
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

      <FieldNote issue={rosterIssue} />
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
  const issueAt = useIssueLookup();
  const at = (part: Parameters<typeof orgField>[1]) => {
    const issue = issueAt(orgField(org.id, part));
    return {
      issue,
      anchor: { 'data-field': orgField(org.id, part) },
      cls: `${field} ${issueClass(issue)}`,
      invalid: issue?.severity === 'error' || undefined,
    };
  };
  const name = at('name');
  const short = at('short_name');
  const country = at('country');
  const city = at('city');
  const kind = at('kind');
  const facebook = at('facebook');
  const x = at('x');
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
        <div className="sm:col-span-2" {...name.anchor}>
          <input
            value={org.display_name}
            onChange={(e) => onChange({ ...org, display_name: e.target.value })}
            placeholder="Organisation name (e.g. National Bureau of Investigation)"
            className={name.cls}
            aria-invalid={name.invalid}
          />
          <FieldNote issue={name.issue} />
        </div>
        <div {...short.anchor}>
          <input
            value={org.short_name}
            onChange={(e) => onChange({ ...org, short_name: e.target.value.slice(0, 20) })}
            placeholder="Short name (e.g. NBI) — optional"
            className={short.cls}
            aria-invalid={short.invalid}
          />
          <FieldNote issue={short.issue} />
        </div>
        <div {...country.anchor}>
          <CountrySelect
            value={org.country}
            onChange={(v) => onChange({ ...org, country: v })}
            className={country.cls}
          />
          <FieldNote issue={country.issue} />
        </div>
        <div {...city.anchor}>
          <input
            value={org.city}
            onChange={(e) => onChange({ ...org, city: e.target.value })}
            placeholder="City (optional)"
            className={city.cls}
            aria-invalid={city.invalid}
          />
          <FieldNote issue={city.issue} />
        </div>
        <div {...kind.anchor}>
          <select
            value={org.kind}
            onChange={(e) => onChange({ ...org, kind: e.target.value as OrgKind })}
            className={kind.cls}
          >
            {(Object.keys(ORG_KIND_LABELS) as OrgKind[]).map((k) => (
              <option key={k} value={k}>
                {ORG_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {kind.issue && (
          <div className="sm:col-span-3 -mt-1">
            <FieldNote issue={kind.issue} />
          </div>
        )}
        <div {...facebook.anchor}>
          <input
            value={org.facebook_handle}
            onChange={(e) => onChange({ ...org, facebook_handle: e.target.value })}
            placeholder="@FacebookHandle (optional)"
            className={facebook.cls}
            aria-invalid={facebook.invalid}
          />
          <FieldNote issue={facebook.issue} />
        </div>
        <div {...x.anchor}>
          <input
            value={org.x_handle}
            onChange={(e) => onChange({ ...org, x_handle: e.target.value })}
            placeholder="@XHandle (optional)"
            className={x.cls}
            aria-invalid={x.invalid}
          />
          <FieldNote issue={x.issue} />
        </div>
      </div>
      <label className="flex items-start gap-2 mb-2 cursor-pointer">
        <input
          type="checkbox"
          checked={org.operation === 'ai'}
          onChange={(e) => onChange({ ...org, operation: e.target.checked ? 'ai' : 'players' })}
          className="mt-0.5"
        />
        <span className="text-[10px] terminal-text text-muted">
          <span className="text-ink">Operated by AI</span> — nobody will play this organisation. Its
          page posts a local line in step with headquarters, and its site leader, HR counterpart and
          staff answer your teams as characters. Teams below still shape who those characters are.
        </span>
      </label>
      {org.proposed_reason && (
        <div className="text-[10px] terminal-text text-accent mb-2">
          Suggested from your description: {org.proposed_reason}
        </div>
      )}
      <div className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-1">
        Teams at this organisation
      </div>
      <RosterBuilder
        roster={org.team_roster}
        onChange={(next) => onChange({ ...org, team_roster: next })}
        presetCatalog={presetCatalog}
        compact
        orgId={org.id}
      />
    </div>
  );
}
