import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

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
  latent_grievances?: Record<string, { grievance: string }>;
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

const Card = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) => (
  <div className="bg-surface-2 border border-border rounded-lg p-4 mb-5">
    <h3 className="text-sm font-bold text-ink">{title}</h3>
    {subtitle && <p className="text-[11px] text-muted mt-0.5 mb-3">{subtitle}</p>}
    {!subtitle && <div className="mb-3" />}
    {children}
  </div>
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
  const antagonists = orgs.filter((o) => o.side !== 'protagonist');
  return (
    <Card
      title={`Organisations (${protagonists.length}) · Countries (${countries.length || 1})`}
      subtitle="The registry every scoped element points at: teams, contacts, feeds and emails belong to one of these organisations. Names and countries are fixed after compile; everything they contain is editable below."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {protagonists.map((o) => {
          const teamNames = teams
            .filter(
              (t) => (t.org_key ?? null) === o.org_key || (protagonists.length === 1 && !t.org_key),
            )
            .map((t) => t.team_name);
          return (
            <div key={o.org_key} className="bg-surface border border-border rounded-lg p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{o.display_name}</span>
                {o.is_primary && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-brand/10 text-brand rounded">
                    Primary
                  </span>
                )}
                <span className="text-[10px] text-muted ml-auto">{o.country}</span>
              </div>
              <div className="text-[10px] text-muted mt-0.5 font-mono">{o.org_key}</div>
              {teamNames.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {teamNames.map((n) => (
                    <span
                      key={n}
                      className="text-[10px] px-1.5 py-0.5 bg-surface-2 text-muted rounded"
                    >
                      {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {antagonists.length > 0 && (
        <div className="text-[11px] text-muted mt-3">
          Rivals: {antagonists.map((a) => `${a.display_name} (${a.country})`).join(', ')}
        </div>
      )}
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
      <Card title="Stakeholder contacts">
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

  const visible = list.filter((s) =>
    filterOrg === 'all'
      ? true
      : filterOrg === 'common'
        ? s.org_key === null
        : s.org_key === filterOrg,
  );

  // Group visible stakeholders by org, then by owning function.
  const groups = new Map<string, StakeholderRecord[]>();
  for (const s of visible) {
    const k = s.org_key ?? '__common';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }

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
      title={`Stakeholder contacts (${list.length})`}
      subtitle="The named people each team deals with. Players see the identity block in their contacts sheet; the hidden character drives how the person replies to emails, DMs and calls, and whether a scheduled inject can still be talked down. Renaming a contact updates every inject they author."
    >
      {multiOrg && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {[
            { key: 'all', label: 'All' },
            ...protagonists.map((o) => ({ key: o.org_key, label: o.display_name })),
            { key: 'common', label: 'Common' },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterOrg(f.key)}
              className={`text-[11px] px-2 py-0.5 rounded border ${filterOrg === f.key ? 'border-brand text-brand bg-brand/5' : 'border-border text-muted hover:text-ink'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {editing && form}

      {Array.from(groups.entries()).map(([k, items]) => (
        <div key={k} className="mb-3">
          {multiOrg && (
            <div className="text-[11px] font-semibold text-brand uppercase mb-1.5">
              {k === '__common'
                ? 'Common — visible to the owning function in every organisation'
                : orgLabel(k)}
            </div>
          )}
          <div className="space-y-2">
            {items.map((s) =>
              editing === s.id ? null : (
                <div key={s.id} className="bg-surface border border-border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-ink">{s.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-surface-2 text-muted rounded">
                          {s.relationship}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent rounded">
                          {s.owning_team}
                        </span>
                        {s.grievance ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-warning/10 text-warning rounded">
                            concern · {s.persuadability}
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 bg-success/10 text-success rounded">
                            pure contact
                          </span>
                        )}
                        {(injectCounts[s.id] || 0) > 0 && (
                          <span className="text-[10px] text-muted">
                            {injectCounts[s.id]} inject(s)
                          </span>
                        )}
                        {s.latent_grievances && Object.keys(s.latent_grievances).length > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-danger/10 text-danger rounded">
                            reacts to {Object.keys(s.latent_grievances).length} decision(s)
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {s.title}, {s.organisation} · {s.email} · {s.handle}
                      </div>
                      <div className="text-xs text-muted mt-1">{s.note}</div>
                      {s.grievance && (
                        <div className="text-[11px] text-warning mt-1">
                          Hidden concern: {s.grievance}
                        </div>
                      )}
                    </div>
                    {!locked && (
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => startEdit(s)}
                          className="text-xs text-brand hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => remove(s)}
                          disabled={saving}
                          className="text-xs text-muted hover:text-danger disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      ))}

      {!locked && !editing && (
        <button onClick={startNew} className="text-xs text-brand hover:underline">
          + Add a stakeholder contact
        </button>
      )}
      {msg && !editing && (
        <span className={`text-xs ml-3 ${error ? 'text-danger' : 'text-success'}`}>{msg}</span>
      )}
    </Card>
  );
};
