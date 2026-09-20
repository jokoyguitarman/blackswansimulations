import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from '../../lib/api';
import { WrSection, WrFold, WrSub, initialsOf, countryCode } from '../UI/Collapsible';
import { WrIcon, type WrIconName } from '../UI/WarRoomIcon';

/**
 * Post-compile editor sections for multi-organisation scenarios (contract §3 / §5):
 * the organisation registry (read-only summary) and full CRUD over stakeholder
 * characters. Every save goes through /api/scenarios/:id/stakeholders, which keeps
 * the runtime invariants (owning function exists, unique identity, authored
 * injects renamed with the character).
 */

export interface StakeholderRecord {
  id: string;
  name: string;
  title: string;
  organisation: string;
  relationship: string;
  owning_team: string;
  org_key: string | null;
  email: string;
  phone: string | null;
  handle: string;
  note: string;
  personality: string;
  stance: string;
  knowledge: string[];
  will_not_disclose: string[];
  grievance: string;
  resolution_criteria: string[];
  persuadability: string;
  hard_constraints: string[];
  // Contract v3.2 additive (cast completeness)
  kind?: 'person' | 'group';
  members?: string[];
  tier?: 'principal' | 'roster';
  site_key?: string;
  sensitivities?: string[];
  page_org_key?: string;
}

interface OrgEntry {
  org_key: string;
  display_name: string;
  country: string;
  side: string;
  is_primary?: boolean;
}

const RELATIONSHIPS = [
  'client',
  'supplier',
  'regulator',
  'partner',
  'internal',
  'media',
  'community',
  'investor',
  'union',
  'other',
];
const PERSUADABILITY = ['none', 'low', 'medium', 'high'];

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60';
const labelCls = 'text-[11px] text-muted font-medium block mb-0.5';

/** Folding section (Situation Map detail view, spec §6.1). */
const Card = ({
  id,
  title,
  subtitle,
  count,
  icon = 'layers',
  family = 'var(--brand)',
  defaultOpen = false,
  peek,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  count?: number | string;
  icon?: WrIconName;
  family?: string;
  defaultOpen?: boolean;
  peek?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <WrSection
    id={id}
    title={title}
    subtitle={subtitle}
    count={count}
    icon={icon}
    family={family}
    defaultOpen={defaultOpen}
    peek={peek}
  >
    {children}
  </WrSection>
);

const ListEditor = ({
  items,
  onChange,
  addLabel,
  max,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  max?: number;
}) => (
  <div className="space-y-1.5">
    {items.map((item, i) => (
      <div key={i} className="flex gap-1.5 items-start">
        <textarea
          value={item}
          rows={1}
          onChange={(e) => {
            const next = [...items];
            next[i] = e.target.value;
            onChange(next);
          }}
          className="flex-1 text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink resize-y"
        />
        <button
          type="button"
          onClick={() => onChange(items.filter((_, j) => j !== i))}
          className="text-muted hover:text-danger text-sm px-1.5 py-1"
          title="Remove"
        >
          ×
        </button>
      </div>
    ))}
    <button
      type="button"
      disabled={max !== undefined && items.length >= max}
      onClick={() => onChange([...items, ''])}
      className="text-xs text-brand hover:underline disabled:opacity-40"
    >
      + {addLabel}
    </button>
  </div>
);

/* ─── Organisation registry ──────────────────────────────────────────────── */

export const OrganisationsSection = ({
  initialState,
  teams,
}: {
  initialState: Record<string, unknown>;
  teams: Array<{ team_name: string; org_key?: string | null }>;
}) => {
  const orgs = (Array.isArray(initialState.orgs) ? initialState.orgs : []) as OrgEntry[];
  const countries = (Array.isArray(initialState.countries) ? initialState.countries : []) as Array<{
    name: string;
  }>;
  if (orgs.length === 0) return null;
  const protagonists = orgs.filter((o) => o.side === 'protagonist');
  const pressure = orgs.filter((o) => o.side === 'pressure');
  const antagonists = orgs.filter((o) => o.side !== 'protagonist' && o.side !== 'pressure');
  const orgExtra = (o: OrgEntry) => o as OrgEntry & { operation?: string; kind?: string };
  return (
    <Card
      id="orgs"
      title="Organisations & pages"
      count={orgs.length}
      icon="building"
      family="var(--f-org)"
      subtitle={`The registry every scoped element points at: teams, contacts, feeds and emails belong to one of these organisations. ${countries.length || 1} countr${(countries.length || 1) === 1 ? 'y' : 'ies'}. Names and countries are fixed after compile; everything they contain is editable below.`}
      peek={
        <>
          <span className="wr-p rel">{protagonists.length} protagonist</span>
          {pressure.length > 0 && <span className="wr-p speaks">{pressure.length} pressure</span>}
          {antagonists.length > 0 && <span className="wr-p rival">{antagonists.length} rival</span>}
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {protagonists.map((o) => {
          const teamNames = teams
            .filter(
              (t) => (t.org_key ?? null) === o.org_key || (protagonists.length === 1 && !t.org_key),
            )
            .map((t) => t.team_name);
          const ai = orgExtra(o).operation === 'ai';
          return (
            <div
              key={o.org_key}
              className={`wr-node ${o.is_primary ? 'hq' : ai ? 'ai' : ''}`}
              style={{ '--g': ai ? 'var(--f-ai)' : 'var(--f-org)' } as CSSProperties}
            >
              <div className="kicker">
                <WrIcon name={o.is_primary ? 'building' : ai ? 'sparkle' : 'office'} size={12} />
                {o.is_primary ? 'Headquarters' : 'Office'} · {ai ? 'AI-operated' : 'players'}
              </div>
              <div className="flex items-center gap-2.5">
                <div
                  className={`wr-mono ${ai ? 'ai' : ''}`}
                  style={{ width: 40, height: 40, fontSize: 13 }}
                >
                  {initialsOf(o.display_name)}
                </div>
                <div className="min-w-0">
                  <div className="font-extrabold text-ink truncate">{o.display_name}</div>
                  <div className="text-xs text-muted flex items-center gap-1.5">
                    <span className="wr-cc">{countryCode(o.country)}</span> {o.country}
                    <span className="font-mono text-[10px]">· {o.org_key}</span>
                  </div>
                </div>
              </div>
              {teamNames.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {teamNames.map((n) => (
                    <span key={n} className="wr-tm">
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {pressure.map((o) => {
          const kind = orgExtra(o).kind;
          const icon: WrIconName =
            kind === 'union'
              ? 'fist'
              : kind === 'ngo'
                ? 'leaf'
                : kind === 'community_group'
                  ? 'community'
                  : kind === 'political'
                    ? 'podium'
                    : 'landmark';
          return (
            <div
              key={o.org_key}
              className="wr-node"
              style={{ '--g': 'var(--f-pressure)' } as CSSProperties}
            >
              <div className="kicker">
                <WrIcon name={icon} size={12} /> Pressure · {kind?.replace(/_/g, ' ') ?? 'group'}
              </div>
              <div className="flex items-center gap-2.5">
                <div className="wr-tile" style={{ width: 40, height: 40 }}>
                  <WrIcon name={icon} size={18} />
                </div>
                <div className="min-w-0">
                  <div className="font-extrabold text-ink truncate">{o.display_name}</div>
                  <div className="text-xs text-muted flex items-center gap-1.5">
                    <span className="wr-cc light">{countryCode(o.country)}</span> {o.country}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {antagonists.map((o) => (
          <div
            key={o.org_key}
            className="wr-node"
            style={{ '--g': 'var(--f-rival)' } as CSSProperties}
          >
            <div className="kicker">
              <WrIcon name="swords" size={12} /> Competitor · AI
            </div>
            <div className="flex items-center gap-2.5">
              <div className="wr-mono rv" style={{ width: 40, height: 40, fontSize: 13 }}>
                {initialsOf(o.display_name)}
              </div>
              <div className="min-w-0">
                <div className="font-extrabold text-ink truncate">{o.display_name}</div>
                <div className="text-xs text-muted flex items-center gap-1.5">
                  <span className="wr-cc light">{countryCode(o.country)}</span> {o.country}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

/* ─── Stakeholders ───────────────────────────────────────────────────────── */

const blankDraft = (orgKey: string | null, owningTeam: string): StakeholderRecord => ({
  id: '',
  name: '',
  title: '',
  organisation: '',
  relationship: 'client',
  owning_team: owningTeam,
  org_key: orgKey,
  email: '',
  phone: null,
  handle: '',
  note: '',
  personality: '',
  stance: '',
  knowledge: [],
  will_not_disclose: [],
  grievance: '',
  resolution_criteria: [],
  persuadability: 'medium',
  hard_constraints: [],
});

export const StakeholdersSection = ({
  scenarioId,
  locked,
  onInjectsChanged,
}: {
  scenarioId: string;
  locked: boolean;
  /** Called after a save that renamed/deleted authored injects so the inject list can refetch. */
  onInjectsChanged?: () => void;
}) => {
  const [list, setList] = useState<StakeholderRecord[]>([]);
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [functions, setFunctions] = useState<string[]>([]);
  const [teams, setTeams] = useState<
    Array<{ team_name: string; org_key: string | null; function_key: string | null }>
  >([]);
  const [injectCounts, setInjectCounts] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<StakeholderRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [filterOrg, setFilterOrg] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<
    'all' | 'principal' | 'live' | 'roster' | 'group' | 'speaks'
  >('all');

  const load = useCallback(async () => {
    try {
      const res = await api.scenarios.getStakeholders(scenarioId);
      setList(res.data as unknown as StakeholderRecord[]);
      setOrgs(res.orgs as OrgEntry[]);
      setFunctions(res.functions);
      setTeams(res.teams);
      setInjectCounts(res.injects_by_stakeholder || {});
      setLoaded(true);
    } catch (err) {
      setLoadError((err as Error).message);
      setLoaded(true);
    }
  }, [scenarioId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return null;
  if (loadError) {
    return (
      <Card id="cast" title="Cast · contacts" icon="target" family="var(--f-intel)" defaultOpen>
        <div className="text-xs text-danger">Could not load stakeholders: {loadError}</div>
      </Card>
    );
  }
  if (list.length === 0 && orgs.length === 0) return null;

  const protagonists = orgs.filter((o) => o.side === 'protagonist');
  const multiOrg = protagonists.length > 1;
  const orgLabel = (key: string | null) =>
    key === null
      ? multiOrg
        ? 'All organisations'
        : ''
      : protagonists.find((o) => o.org_key === key)?.display_name || key;

  /** Functions available for the draft's org (null org = every function anywhere). */
  const functionsFor = (orgKey: string | null): string[] => {
    if (orgKey === null) return functions;
    const fns = new Set<string>();
    for (const t of teams) {
      if (t.org_key !== null && t.org_key !== orgKey) continue;
      fns.add(t.function_key ?? t.team_name);
    }
    return fns.size > 0 ? Array.from(fns) : functions;
  };

  const q = search.trim().toLowerCase();
  const visible = list.filter((s) => {
    if (
      filterOrg === 'common' ? s.org_key !== null : filterOrg !== 'all' && s.org_key !== filterOrg
    )
      return false;
    if (stateFilter === 'principal' && (s.tier === 'roster' || s.kind === 'group')) return false;
    if (stateFilter === 'live' && !s.grievance) return false;
    if (stateFilter === 'roster' && s.tier !== 'roster') return false;
    if (stateFilter === 'group' && s.kind !== 'group') return false;
    if (stateFilter === 'speaks' && !s.page_org_key) return false;
    if (!q) return true;
    return `${s.name} ${s.title} ${s.organisation} ${s.relationship} ${s.owning_team} ${s.email}`
      .toLowerCase()
      .includes(q);
  });
  const filtering = !!q || stateFilter !== 'all' || filterOrg !== 'all';

  // Group visible stakeholders by org → relationship (roster and lists as their own groups).
  const REL_LABEL: Record<string, string> = {
    internal: 'Internal',
    client: 'Clients',
    partner: 'Partners',
    supplier: 'Suppliers',
    media: 'Media',
    regulator: 'Regulators',
    union: 'Union',
    community: 'Community',
    investor: 'Investors & board',
    other: 'Other',
  };
  const REL_ORDER = [
    'internal',
    'client',
    'partner',
    'supplier',
    'media',
    'regulator',
    'union',
    'community',
    'investor',
    'other',
    '__roster',
    '__list',
  ];
  const groups = new Map<string, Map<string, StakeholderRecord[]>>();
  for (const s of visible) {
    const k = s.org_key ?? '__common';
    const rel =
      s.kind === 'group' ? '__list' : s.tier === 'roster' ? '__roster' : s.relationship || 'other';
    if (!groups.has(k)) groups.set(k, new Map());
    const byRel = groups.get(k)!;
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel)!.push(s);
  }
  const orgOrder = [
    ...protagonists.map((o) => o.org_key),
    ...orgs.filter((o) => o.side !== 'protagonist').map((o) => o.org_key),
    '__common',
  ];
  const orderedGroups = [...groups.entries()].sort(
    (a, b) => orgOrder.indexOf(a[0]) - orgOrder.indexOf(b[0]),
  );
  const orgCountry = (key: string) => orgs.find((o) => o.org_key === key)?.country ?? null;
  const orgSide = (key: string) => orgs.find((o) => o.org_key === key)?.side ?? 'protagonist';
  const liveCount = list.filter((s) => !!s.grievance).length;
  const rosterCount = list.filter((s) => s.tier === 'roster').length;
  const listCount = list.filter((s) => s.kind === 'group').length;
  const pureCount = list.length - liveCount - rosterCount - listCount;

  const startEdit = (s: StakeholderRecord) => {
    setEditing(s.id);
    setDraft({
      ...s,
      knowledge: [...s.knowledge],
      will_not_disclose: [...s.will_not_disclose],
      resolution_criteria: [...s.resolution_criteria],
      hard_constraints: [...s.hard_constraints],
    });
    setMsg(null);
  };

  const startNew = () => {
    const orgKey = multiOrg ? (protagonists[0]?.org_key ?? null) : null;
    setEditing('new');
    setDraft(blankDraft(orgKey, functionsFor(orgKey)[0] || 'Communications'));
    setMsg(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        name: draft.name,
        title: draft.title,
        organisation: draft.organisation,
        relationship: draft.relationship,
        owning_team: draft.owning_team,
        org_key: draft.org_key,
        ...(draft.email ? { email: draft.email } : {}),
        phone: draft.phone || null,
        ...(draft.handle ? { handle: draft.handle } : {}),
        note: draft.note,
        personality: draft.personality || 'Professional, direct.',
        stance: draft.stance || 'Watching how the organisation responds.',
        knowledge: draft.knowledge,
        will_not_disclose: draft.will_not_disclose,
        grievance: draft.grievance,
        resolution_criteria: draft.resolution_criteria,
        persuadability: draft.persuadability,
        hard_constraints: draft.hard_constraints,
      };
      if (editing === 'new') {
        const res = await api.scenarios.createStakeholder(scenarioId, body);
        setList((prev) => [...prev, res.data as unknown as StakeholderRecord]);
        setMsg('Contact created');
      } else if (editing) {
        const res = await api.scenarios.updateStakeholder(scenarioId, editing, body);
        setList((prev) =>
          prev.map((s) => (s.id === editing ? (res.data as unknown as StakeholderRecord) : s)),
        );
        setMsg(
          res.injects_updated > 0
            ? `Saved · ${res.injects_updated} authored inject(s) updated`
            : 'Saved',
        );
        if (res.injects_updated > 0) onInjectsChanged?.();
      }
      setError(false);
      setEditing(null);
      setDraft(null);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: StakeholderRecord) => {
    const count = injectCounts[s.id] || 0;
    const ok = window.confirm(
      count > 0
        ? `${s.name} authors ${count} inject(s). Delete the contact AND those injects?`
        : `Delete ${s.name}?`,
    );
    if (!ok) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.scenarios.deleteStakeholder(scenarioId, s.id, count > 0);
      setList((prev) => prev.filter((x) => x.id !== s.id));
      setMsg(
        res.injects_deleted > 0 ? `Deleted · ${res.injects_deleted} inject(s) removed` : 'Deleted',
      );
      setError(false);
      if (res.injects_deleted > 0) onInjectsChanged?.();
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const form = draft && (
    <div className="bg-surface border border-brand/40 rounded-lg p-3 mb-3">
      <div className="text-sm font-semibold text-ink mb-2">
        {editing === 'new' ? 'New stakeholder contact' : draft.name}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className={labelCls}>Name</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Title</label>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Organisation (their employer)</label>
          <input
            value={draft.organisation}
            onChange={(e) => setDraft({ ...draft, organisation: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Relationship</label>
          <select
            value={draft.relationship}
            onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
            className={inputCls}
          >
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        {multiOrg && (
          <div>
            <label className={labelCls}>Belongs to</label>
            <select
              value={draft.org_key ?? '__common'}
              onChange={(e) => {
                const orgKey = e.target.value === '__common' ? null : e.target.value;
                const fns = functionsFor(orgKey);
                setDraft({
                  ...draft,
                  org_key: orgKey,
                  owning_team: fns.includes(draft.owning_team)
                    ? draft.owning_team
                    : fns[0] || draft.owning_team,
                });
              }}
              className={inputCls}
            >
              <option value="__common">All organisations (common)</option>
              {protagonists.map((o) => (
                <option key={o.org_key} value={o.org_key}>
                  {o.display_name} · {o.country}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Owning team (function)</label>
          <select
            value={draft.owning_team}
            onChange={(e) => setDraft({ ...draft, owning_team: e.target.value })}
            className={inputCls}
          >
            {functionsFor(draft.org_key).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {!functionsFor(draft.org_key).includes(draft.owning_team) && draft.owning_team && (
              <option value={draft.owning_team}>{draft.owning_team}</option>
            )}
          </select>
        </div>
        <div>
          <label className={labelCls}>Email {editing === 'new' && '(blank = generated)'}</label>
          <input
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Phone (optional)</label>
          <input
            value={draft.phone || ''}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value || null })}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Handle {editing === 'new' && '(blank = generated)'}</label>
          <input
            value={draft.handle}
            onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
            className={inputCls}
          />
        </div>
      </div>
      <label className={`${labelCls} mt-2`}>
        Contacts-sheet note (players see this — never reveal the concern or timing)
      </label>
      <textarea
        value={draft.note}
        rows={2}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        className={`${inputCls} resize-y`}
      />

      <div className="mt-3 border-t border-border pt-2">
        <div className="text-[11px] font-semibold text-ink mb-1">
          Hidden character (drives replies)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Personality</label>
            <textarea
              value={draft.personality}
              rows={2}
              onChange={(e) => setDraft({ ...draft, personality: e.target.value })}
              className={`${inputCls} resize-y`}
            />
          </div>
          <div>
            <label className={labelCls}>Stance toward the organisation</label>
            <textarea
              value={draft.stance}
              rows={2}
              onChange={(e) => setDraft({ ...draft, stance: e.target.value })}
              className={`${inputCls} resize-y`}
            />
          </div>
          <div>
            <label className={labelCls}>Knows and will share if asked</label>
            <ListEditor
              items={draft.knowledge}
              onChange={(v) => setDraft({ ...draft, knowledge: v })}
              addLabel="Add fact"
              max={6}
            />
          </div>
          <div>
            <label className={labelCls}>Will not disclose</label>
            <ListEditor
              items={draft.will_not_disclose}
              onChange={(v) => setDraft({ ...draft, will_not_disclose: v })}
              addLabel="Add item"
              max={4}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-2">
        <div className="text-[11px] font-semibold text-ink mb-1">
          Grievance (leave empty for a pure contact)
        </div>
        <textarea
          value={draft.grievance}
          rows={2}
          placeholder="What is driving this person's scheduled action, if anything?"
          onChange={(e) => setDraft({ ...draft, grievance: e.target.value })}
          className={`${inputCls} resize-y`}
        />
        {draft.grievance.trim() && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
            <div className="sm:col-span-2">
              <label className={labelCls}>Resolution criteria (1-4, checkable)</label>
              <ListEditor
                items={draft.resolution_criteria}
                onChange={(v) => setDraft({ ...draft, resolution_criteria: v })}
                addLabel="Add criterion"
                max={4}
              />
            </div>
            <div>
              <label className={labelCls}>Persuadability</label>
              <select
                value={draft.persuadability}
                onChange={(e) => setDraft({ ...draft, persuadability: e.target.value })}
                className={inputCls}
              >
                {PERSUADABILITY.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <label className={`${labelCls} mt-2`}>Hard constraints</label>
              <ListEditor
                items={draft.hard_constraints}
                onChange={(v) => setDraft({ ...draft, hard_constraints: v })}
                addLabel="Add constraint"
                max={4}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-3 items-center">
        <button
          onClick={save}
          disabled={
            saving || !draft.name.trim() || !draft.title.trim() || !draft.organisation.trim()
          }
          className="text-xs px-3 py-1 bg-brand text-white rounded disabled:opacity-40"
        >
          {saving ? 'Saving…' : editing === 'new' ? 'Create contact' : 'Save contact'}
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setDraft(null);
          }}
          disabled={saving}
          className="text-xs px-3 py-1 border border-border rounded text-muted"
        >
          Cancel
        </button>
        {msg && (
          <span className={`text-xs ml-2 ${error ? 'text-danger' : 'text-success'}`}>{msg}</span>
        )}
      </div>
    </div>
  );

  return (
    <Card
      id="cast"
      title="Cast · contacts"
      count={list.length}
      icon="target"
      family="var(--f-intel)"
      defaultOpen
      subtitle="Every person your teams can email, message or call. Players see the identity block in their contacts sheet; the hidden character drives how the person replies and whether a scheduled inject can still be talked down. Grouped by organisation; the roster is folded so the principals stay in view."
      peek={
        <>
          {liveCount > 0 && <span className="wr-p live">{liveCount} with a live concern</span>}
          {pureCount > 0 && <span className="wr-p pure">{pureCount} pure contacts</span>}
          {rosterCount > 0 && <span className="wr-p roster">{rosterCount} roster</span>}
          {listCount > 0 && <span className="wr-p group">{listCount} lists</span>}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="wr-search" style={{ flex: '1 1 220px' }}>
          <WrIcon name="search" />
          <input
            className="wr-field"
            style={{ padding: '8px 10px 8px 34px', fontSize: 12.5 }}
            placeholder="Search name, title, organisation…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="wr-seg sm" role="group" aria-label="Contact type">
          {(
            [
              ['all', 'All'],
              ['principal', 'Principals'],
              ['live', 'Live concern'],
              ['roster', 'Roster'],
              ['group', 'Lists'],
              ['speaks', 'Spokespersons'],
            ] as Array<[typeof stateFilter, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={stateFilter === k ? 'on' : ''}
              onClick={() => setStateFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {multiOrg && (
          <div className="wr-seg sm" role="group" aria-label="Organisation">
            {[
              { key: 'all', label: 'All orgs' },
              ...protagonists.map((o) => ({ key: o.org_key, label: o.display_name })),
              { key: 'common', label: 'Common' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilterOrg(f.key)}
                className={filterOrg === f.key ? 'on' : ''}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        {!locked && !editing && (
          <button onClick={startNew} className="wr-btn sm ml-auto">
            <WrIcon name="plus" /> Add contact
          </button>
        )}
      </div>

      {editing && form}

      {orderedGroups.length === 0 && (
        <div className="text-xs text-muted py-3">No contacts match.</div>
      )}

      {orderedGroups.map(([k, byRel], gi) => {
        const total = [...byRel.values()].reduce((n, arr) => n + arr.length, 0);
        const side = k === '__common' ? 'common' : orgSide(k);
        const country = k === '__common' ? null : orgCountry(k);
        return (
          <WrFold
            key={k}
            title={
              k === '__common'
                ? multiOrg
                  ? 'Common to every organisation'
                  : orgLabel(protagonists[0]?.org_key ?? null) || 'Contacts'
                : orgLabel(k)
            }
            count={total}
            sub={
              k === '__common'
                ? 'visible to the owning function everywhere'
                : side === 'pressure'
                  ? 'pressure organisation'
                  : side === 'antagonist'
                    ? 'rival'
                    : country
                      ? country
                      : undefined
            }
            lead={
              country ? (
                <span className="wr-cc">{countryCode(country)}</span>
              ) : (
                <WrIcon name="target" size={14} className="text-muted" />
              )
            }
            defaultOpen={gi === 0 || filtering || !multiOrg}
          >
            {[...byRel.entries()]
              .sort((a, b) => REL_ORDER.indexOf(a[0]) - REL_ORDER.indexOf(b[0]))
              .map(([rel, items], ri) => (
                <WrSub
                  key={rel}
                  title={
                    rel === '__roster'
                      ? 'Workforce roster'
                      : rel === '__list'
                        ? 'Distribution lists'
                        : (REL_LABEL[rel] ?? rel)
                  }
                  count={items.length}
                  hint={
                    rel === '__roster'
                      ? 'reachable via the distribution list · never author injects'
                      : rel === '__list'
                        ? 'one email reaches every member'
                        : undefined
                  }
                  defaultOpen={filtering || (rel !== '__roster' && rel !== '__list' && ri < 4)}
                >
                  {items.map((s) =>
                    editing === s.id ? null : (
                      <div key={s.id} className="wr-row">
                        <div
                          className={`wr-mono av ${
                            s.page_org_key
                              ? 'pr'
                              : s.kind === 'group'
                                ? 'plain'
                                : s.tier === 'roster'
                                  ? 'plain'
                                  : ''
                          }`}
                        >
                          {s.kind === 'group' ? (
                            <WrIcon name="mail" size={14} />
                          ) : (
                            initialsOf(s.name)
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="nm">
                            <span className="truncate">{s.name}</span>
                            {rel !== '__roster' && rel !== '__list' && (
                              <span className="wr-p rel">{s.relationship}</span>
                            )}
                            {s.kind === 'group' ? (
                              <span className="wr-p group">
                                list · {(s.members || []).length} members
                              </span>
                            ) : s.tier === 'roster' ? (
                              <span className="wr-p roster">roster</span>
                            ) : s.grievance ? (
                              <span className="wr-p live">
                                live concern
                                {(injectCounts[s.id] || 0) > 0
                                  ? ` · ${injectCounts[s.id]} inject${injectCounts[s.id] === 1 ? '' : 's'}`
                                  : ''}
                              </span>
                            ) : (
                              <span className="wr-p pure">pure contact</span>
                            )}
                            {s.page_org_key && (
                              <span className="wr-p speaks">
                                speaks for {orgLabel(s.page_org_key)}
                              </span>
                            )}
                          </div>
                          <div className="ti truncate">
                            {s.title}
                            {s.organisation ? ` · ${s.organisation}` : ''} · owned by{' '}
                            {s.owning_team}
                            {s.kind !== 'group' && s.tier !== 'roster' && s.persuadability
                              ? ` · persuadability ${s.persuadability}`
                              : ''}
                          </div>
                          {s.grievance && (
                            <div className="text-[11.5px] text-accent-strong mt-0.5">
                              Hidden concern: {s.grievance}
                            </div>
                          )}
                          {s.note && rel !== '__roster' && (
                            <div className="text-[11.5px] text-muted mt-0.5 line-clamp-2">
                              {s.note}
                            </div>
                          )}
                        </div>
                        <div className="pills">
                          {s.email && <span className="wr-p font-mono">{s.email}</span>}
                          {!locked && (
                            <>
                              <button
                                onClick={() => startEdit(s)}
                                className="wr-btn sm ghost icon"
                                aria-label={`Edit ${s.name}`}
                                title="Edit"
                              >
                                <WrIcon name="edit" />
                              </button>
                              <button
                                onClick={() => remove(s)}
                                disabled={saving}
                                className="wr-btn sm ghost icon"
                                aria-label={`Delete ${s.name}`}
                                title="Delete"
                              >
                                <WrIcon name="trash" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ),
                  )}
                </WrSub>
              ))}
          </WrFold>
        );
      })}

      {msg && !editing && (
        <span className={`text-xs ml-1 ${error ? 'text-danger' : 'text-success'}`}>{msg}</span>
      )}
    </Card>
  );
};
