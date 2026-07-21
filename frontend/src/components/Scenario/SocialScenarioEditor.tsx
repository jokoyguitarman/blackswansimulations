import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';

/**
 * Post-compile editor for social media crisis scenarios.
 *
 * The warroom generates the full scenario quickly; this editor lets the
 * trainer personalise everything afterwards: narrative, NPC personas, fact
 * sheet, org pages, research guidelines, team charters, objectives, and the
 * full inject timeline (including regenerating stale post images).
 *
 * Every field shown here has a verified runtime consumer — the sim reads
 * injects and initial_state live, so saved edits genuinely reach the game.
 * Editing locks (server-enforced, mirrored here) when the trainer has no
 * session launch credits or while a session on this scenario is live.
 */

interface InjectRow {
  id: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[] | null;
  requires_response?: boolean;
  delivery_config?: Record<string, unknown> | null;
  generation_source?: string;
}

interface TeamRow {
  id: string;
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  charter?: {
    mission?: string;
    responsibilities?: string[];
    out_of_lane?: string[];
  } | null;
  expected_actions?: Array<Record<string, unknown>> | null;
  scoring_rubric?: string | null;
}

interface ObjectiveRow {
  id: string;
  objective_id: string;
  objective_name: string;
  description: string | null;
  weight: number;
}

interface ScenarioShape {
  id: string;
  title: string;
  description: string;
  briefing?: string;
  duration_minutes: number;
  created_at: string;
  objectives: string[];
  initial_state?: Record<string, unknown>;
}

interface Editability {
  editable: boolean;
  reason: 'ok' | 'live_session' | 'no_session_credits';
  session_credits: number;
  live_session_id: string | null;
}

interface Props {
  scenarioId: string;
  scenario: ScenarioShape;
  injects: InjectRow[];
  teams: TeamRow[];
  onClose: () => void;
}

// ─── Small shared pieces ─────────────────────────────────────────────────────

const SaveStatus = ({
  saving,
  msg,
  error,
}: {
  saving: boolean;
  msg: string | null;
  error: boolean;
}) => {
  if (saving) return <span className="text-xs text-muted animate-pulse ml-2">Saving…</span>;
  if (!msg) return null;
  return <span className={`text-xs ml-2 ${error ? 'text-danger' : 'text-success'}`}>{msg}</span>;
};

const SectionCard = ({
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

const StringListEditor = ({
  items,
  onChange,
  disabled,
  placeholder,
  addLabel,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  placeholder?: string;
  addLabel?: string;
}) => (
  <div className="space-y-1.5">
    {items.map((item, i) => (
      <div key={i} className="flex gap-1.5 items-start">
        <textarea
          value={item}
          disabled={disabled}
          rows={Math.min(3, Math.max(1, Math.ceil(item.length / 90)))}
          onChange={(e) => {
            const next = [...items];
            next[i] = e.target.value;
            onChange(next);
          }}
          placeholder={placeholder}
          className="flex-1 text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60 resize-y"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(items.filter((_, j) => j !== i))}
          className="text-muted hover:text-danger text-sm px-1.5 py-1 disabled:opacity-40"
          title="Remove"
        >
          ×
        </button>
      </div>
    ))}
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange([...items, ''])}
      className="text-xs text-brand hover:underline disabled:opacity-40"
    >
      + {addLabel || 'Add item'}
    </button>
  </div>
);

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60';
const labelCls = 'text-[11px] text-muted font-medium block mb-0.5';

// ─── Main component ──────────────────────────────────────────────────────────

export const SocialScenarioEditor = ({ scenarioId, scenario, injects, teams, onClose }: Props) => {
  const [editability, setEditability] = useState<Editability | null>(null);
  const [editabilityError, setEditabilityError] = useState<string | null>(null);

  const [scen, setScen] = useState<ScenarioShape>(scenario);
  const [injectList, setInjectList] = useState<InjectRow[]>(injects);
  const [teamList, setTeamList] = useState<TeamRow[]>(teams);
  const [objectiveList, setObjectiveList] = useState<ObjectiveRow[]>([]);

  const initialState = (scen.initial_state ?? {}) as Record<string, unknown>;
  const locked = !editability?.editable;

  useEffect(() => {
    api.scenarios
      .getEditability(scenarioId)
      .then((res) => setEditability(res.data))
      .catch((err: Error) => {
        // Fail closed in the UI (server enforces regardless).
        setEditability({
          editable: false,
          reason: 'ok',
          session_credits: 0,
          live_session_id: null,
        });
        setEditabilityError(err.message);
      });
    api.scenarios
      .getObjectives(scenarioId)
      .then((res) => setObjectiveList(res.data as ObjectiveRow[]))
      .catch(() => setObjectiveList([]));
  }, [scenarioId]);

  /** PATCH the scenario row with a partial initial_state mutation applied. */
  const saveInitialState = useCallback(
    async (mutate: (is: Record<string, unknown>) => Record<string, unknown>) => {
      const next = mutate({ ...((scen.initial_state ?? {}) as Record<string, unknown>) });
      await api.scenarios.update(scenarioId, { initial_state: next });
      setScen((s) => ({ ...s, initial_state: next }));
      return next;
    },
    [scen.initial_state, scenarioId],
  );

  return (
    <div className="fixed inset-0 bg-ink/40 backdrop-blur-md z-50 flex items-start justify-center p-4 sm:p-6">
      <div className="max-w-4xl w-full my-2 bg-surface border border-border rounded-2xl shadow-lg flex flex-col max-h-[94vh] overflow-hidden">
        {/* Sticky header */}
        <div className="flex-shrink-0 flex items-center justify-between px-6 sm:px-8 pt-5 pb-4 border-b border-border bg-gradient-to-b from-white to-[#FDFBF7]">
          <div className="flex items-center gap-3">
            <span
              className="w-11 h-11 rounded-xl bg-accent text-white grid place-items-center text-xl flex-shrink-0"
              aria-hidden
            >
              📱
            </span>
            <div>
              <h1 className="text-lg font-extrabold text-brand leading-snug">{scen.title}</h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-accent/10 text-accent">
                  Social Media Crisis
                </span>
                <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-surface-2 text-muted border border-border">
                  {scen.duration_minutes} min
                </span>
                <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-surface-2 text-muted border border-border">
                  {teamList.length} teams
                </span>
                <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-surface-2 text-muted border border-border">
                  {injectList.length} injects
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 rounded-lg border border-border bg-surface text-muted hover:text-ink hover:border-border-strong text-base flex-shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-5">
          {/* Edit lock banner */}
          {editability === null ? (
            <div className="text-xs text-muted mb-4 animate-pulse">Checking edit permissions…</div>
          ) : locked ? (
            <div className="bg-warning/10 border border-warning/40 rounded-lg p-3 mb-5 flex items-start gap-2">
              <span className="text-warning text-base">🔒</span>
              <div>
                <div className="text-xs font-bold text-ink">Editing locked</div>
                <div className="text-xs text-muted mt-0.5">
                  {editabilityError
                    ? `Could not verify edit permissions: ${editabilityError}`
                    : editability.reason === 'live_session'
                      ? 'A session on this scenario is currently live. Editing resumes when it ends.'
                      : 'No session launch credits remaining. Editing reopens when credits are topped up.'}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-brand/5 border border-brand/20 rounded-lg p-3 mb-5">
              <div className="text-xs text-muted">
                Everything below is editable — changes apply to all sessions launched after saving.
                <span className="text-muted">
                  {' '}
                  Session credits remaining: {editability.session_credits}
                </span>
              </div>
            </div>
          )}

          <OverviewSection scen={scen} setScen={setScen} scenarioId={scenarioId} locked={locked} />
          <PersonasSection
            scenarioId={scenarioId}
            initialState={initialState}
            saveInitialState={saveInitialState}
            injectList={injectList}
            setInjectList={setInjectList}
            locked={locked}
          />
          <FactSheetSection
            initialState={initialState}
            saveInitialState={saveInitialState}
            locked={locked}
          />
          <OrgPagesSection
            initialState={initialState}
            saveInitialState={saveInitialState}
            locked={locked}
          />
          <InjectsSection
            scenarioId={scenarioId}
            injectList={injectList}
            setInjectList={setInjectList}
            teamList={teamList}
            initialState={initialState}
            locked={locked}
          />
          <TeamsSection
            scenarioId={scenarioId}
            teamList={teamList}
            setTeamList={setTeamList}
            locked={locked}
          />
          <ObjectivesSection
            scenarioId={scenarioId}
            objectiveList={objectiveList}
            setObjectiveList={setObjectiveList}
            locked={locked}
          />
          <ResearchGuidelinesSection
            initialState={initialState}
            saveInitialState={saveInitialState}
            locked={locked}
          />

          <div className="text-xs text-muted mt-6">
            Created {new Date(scen.created_at).toLocaleDateString()} | {objectiveList.length}{' '}
            objectives | {injectList.length} injects
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Overview ────────────────────────────────────────────────────────────────

const OverviewSection = ({
  scen,
  setScen,
  scenarioId,
  locked,
}: {
  scen: ScenarioShape;
  setScen: React.Dispatch<React.SetStateAction<ScenarioShape>>;
  scenarioId: string;
  locked: boolean;
}) => {
  const [title, setTitle] = useState(scen.title);
  const [description, setDescription] = useState(scen.description);
  const [briefing, setBriefing] = useState(scen.briefing ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const dirty =
    title !== scen.title || description !== scen.description || briefing !== (scen.briefing ?? '');

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.scenarios.update(scenarioId, { title, description, briefing });
      setScen((s) => ({ ...s, title, description, briefing }));
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard title="Overview" subtitle="Title, description, and participant briefing.">
      <label className={labelCls}>Title</label>
      <input
        value={title}
        disabled={locked}
        onChange={(e) => setTitle(e.target.value)}
        className={inputCls}
      />
      <label className={`${labelCls} mt-2`}>Description</label>
      <textarea
        value={description}
        disabled={locked}
        rows={3}
        onChange={(e) => setDescription(e.target.value)}
        className={`${inputCls} resize-y`}
      />
      <label className={`${labelCls} mt-2`}>Briefing</label>
      <textarea
        value={briefing}
        disabled={locked}
        rows={4}
        onChange={(e) => setBriefing(e.target.value)}
        className={`${inputCls} resize-y`}
      />
      <div className="mt-2 flex items-center">
        <button
          onClick={save}
          disabled={locked || saving || !dirty || !title.trim() || !description.trim()}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        >
          Save overview
        </button>
        <SaveStatus saving={saving} msg={msg} error={error} />
      </div>
    </SectionCard>
  );
};

// ─── NPC Personas ────────────────────────────────────────────────────────────

interface PersonaShape {
  name?: string;
  handle?: string;
  personality?: string;
  bias?: string;
  [k: string]: unknown;
}

const PersonasSection = ({
  scenarioId,
  initialState,
  saveInitialState,
  injectList,
  setInjectList,
  locked,
}: {
  scenarioId: string;
  initialState: Record<string, unknown>;
  saveInitialState: (
    mutate: (is: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  injectList: InjectRow[];
  setInjectList: React.Dispatch<React.SetStateAction<InjectRow[]>>;
  locked: boolean;
}) => {
  const personas = (initialState.npc_personas || []) as PersonaShape[];
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<PersonaShape | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const startEdit = (i: number) => {
    setEditing(i);
    setDraft({ ...personas[i] });
    setMsg(null);
  };

  const savePersona = async () => {
    if (draft === null || editing === null) return;
    setSaving(true);
    setMsg(null);
    try {
      const isNew = editing >= personas.length;
      const old = isNew ? null : personas[editing];
      const oldHandle = old ? String(old.handle || '') : '';
      const newHandle = String(draft.handle || '');

      await saveInitialState((is) => {
        const list = [...((is.npc_personas || []) as PersonaShape[])];
        if (isNew) list.push(draft);
        else list[editing] = draft;
        return { ...is, npc_personas: list };
      });

      // Propagate a handle/name change onto injects authored by this persona
      // so posts never fire under a dead handle.
      let touched = 0;
      if (!isNew && oldHandle && oldHandle !== newHandle) {
        const referencing = injectList.filter(
          (inj) => String(inj.delivery_config?.author_handle || '') === oldHandle,
        );
        for (const inj of referencing) {
          const dc = {
            ...(inj.delivery_config || {}),
            author_handle: newHandle,
            author_display_name: String(draft.name || ''),
          };
          const res = await api.scenarios.updateInject(scenarioId, inj.id, {
            delivery_config: dc,
          });
          setInjectList((list) =>
            list.map((x) => (x.id === inj.id ? ({ ...x, ...res.data } as InjectRow) : x)),
          );
          touched++;
        }
      }

      setMsg(touched > 0 ? `Saved — ${touched} inject(s) re-pointed to ${newHandle}` : 'Saved');
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

  const removePersona = async (i: number) => {
    const handle = String(personas[i]?.handle || '');
    const referencing = injectList.filter(
      (inj) => String(inj.delivery_config?.author_handle || '') === handle,
    ).length;
    const warning =
      referencing > 0
        ? `Remove ${personas[i]?.name}? ${referencing} inject(s) are authored by ${handle} — reassign them to another persona afterwards.`
        : `Remove ${personas[i]?.name}?`;
    if (!window.confirm(warning)) return;
    setSaving(true);
    setMsg(null);
    try {
      await saveInitialState((is) => {
        const list = [...((is.npc_personas || []) as PersonaShape[])];
        list.splice(i, 1);
        return { ...is, npc_personas: list };
      });
      setMsg('Persona removed');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title={`NPC Personas (${personas.length})`}
      subtitle="The AI engines read these live: personality and bias steer every post, reply, and reaction the NPC makes."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {personas.map((npc, i) =>
          editing === i && draft ? (
            <PersonaForm
              key={i}
              draft={draft}
              setDraft={setDraft}
              saving={saving}
              onSave={savePersona}
              onCancel={() => {
                setEditing(null);
                setDraft(null);
              }}
            />
          ) : (
            <div key={i} className="bg-surface border border-border rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
                  {String(npc.name || '?').charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">{String(npc.name)}</div>
                  <div className="text-xs text-muted truncate">{String(npc.handle)}</div>
                </div>
                {!locked && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => startEdit(i)}
                      className="text-xs text-brand hover:underline"
                      disabled={saving}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => removePersona(i)}
                      className="text-xs text-muted hover:text-danger"
                      disabled={saving}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              <div className="text-xs text-muted mt-1">
                {String(npc.personality || '').substring(0, 120)}
              </div>
              {!!npc.bias && String(npc.bias) !== 'none' && (
                <span className="text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent rounded mt-1 inline-block">
                  bias: {String(npc.bias)}
                </span>
              )}
            </div>
          ),
        )}
        {editing !== null && editing >= personas.length && draft && (
          <PersonaForm
            draft={draft}
            setDraft={setDraft}
            saving={saving}
            onSave={savePersona}
            onCancel={() => {
              setEditing(null);
              setDraft(null);
            }}
          />
        )}
      </div>
      <div className="mt-2 flex items-center">
        {!locked && editing === null && (
          <button
            onClick={() => {
              setEditing(personas.length);
              setDraft({ name: '', handle: '@', personality: '', bias: 'none' });
              setMsg(null);
            }}
            className="text-xs text-brand hover:underline"
            disabled={saving}
          >
            + Add persona
          </button>
        )}
        <SaveStatus saving={false} msg={msg} error={error} />
      </div>
    </SectionCard>
  );
};

const PersonaForm = ({
  draft,
  setDraft,
  saving,
  onSave,
  onCancel,
}: {
  draft: PersonaShape;
  setDraft: React.Dispatch<React.SetStateAction<PersonaShape | null>>;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) => (
  <div className="bg-surface border border-brand/40 rounded-lg p-3">
    <label className={labelCls}>Name</label>
    <input
      value={String(draft.name || '')}
      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
      className={inputCls}
    />
    <label className={`${labelCls} mt-1.5`}>Handle</label>
    <input
      value={String(draft.handle || '')}
      onChange={(e) => setDraft((d) => ({ ...d, handle: e.target.value }))}
      className={inputCls}
      placeholder="@handle"
    />
    <label className={`${labelCls} mt-1.5`}>Personality</label>
    <textarea
      value={String(draft.personality || '')}
      rows={3}
      onChange={(e) => setDraft((d) => ({ ...d, personality: e.target.value }))}
      className={`${inputCls} resize-y`}
      placeholder="How this NPC behaves, writes, and reacts"
    />
    <label className={`${labelCls} mt-1.5`}>Bias</label>
    <input
      value={String(draft.bias || '')}
      onChange={(e) => setDraft((d) => ({ ...d, bias: e.target.value }))}
      className={inputCls}
      placeholder="none, anti_org, sensationalist…"
    />
    <div className="flex gap-2 mt-2">
      <button
        onClick={onSave}
        disabled={saving || !String(draft.name || '').trim() || !String(draft.handle || '').trim()}
        className="text-xs px-3 py-1 bg-brand text-white rounded disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        onClick={onCancel}
        disabled={saving}
        className="text-xs px-3 py-1 border border-border rounded text-muted"
      >
        Cancel
      </button>
    </div>
  </div>
);

// ─── Fact sheet ──────────────────────────────────────────────────────────────

interface ClaimShape {
  claim?: string;
  status?: string;
  truth?: string;
  [k: string]: unknown;
}

const FactSheetSection = ({
  initialState,
  saveInitialState,
  locked,
}: {
  initialState: Record<string, unknown>;
  saveInitialState: (
    mutate: (is: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  locked: boolean;
}) => {
  const factSheet = (initialState.fact_sheet || {}) as Record<string, unknown>;
  const [facts, setFacts] = useState<string[]>((factSheet.confirmed_facts || []) as string[]);
  const [claims, setClaims] = useState<ClaimShape[]>(
    (factSheet.unconfirmed_claims || []) as ClaimShape[],
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const cleanFacts = facts.map((f) => f.trim()).filter(Boolean);
      const cleanClaims = claims.filter((c) => String(c.claim || '').trim());
      await saveInitialState((is) => ({
        ...is,
        fact_sheet: {
          ...((is.fact_sheet || {}) as Record<string, unknown>),
          confirmed_facts: cleanFacts,
          unconfirmed_claims: cleanClaims,
        },
      }));
      setFacts(cleanFacts);
      setClaims(cleanClaims);
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Fact Sheet"
      subtitle="Ground truth for the sim: the fact-check tool, statement watchdog, dispute system, and NPC engines all verify against this live."
    >
      <h4 className="text-xs font-bold text-success mb-1.5">Confirmed facts</h4>
      <StringListEditor items={facts} onChange={setFacts} disabled={locked} addLabel="Add fact" />

      <h4 className="text-xs font-bold text-danger mt-4 mb-1.5">False / unverified claims</h4>
      <div className="space-y-2">
        {claims.map((c, i) => (
          <div key={i} className="bg-surface border border-border rounded p-2">
            <div className="flex gap-2 items-start">
              <select
                value={String(c.status || 'UNVERIFIED')}
                disabled={locked}
                onChange={(e) => {
                  const next = [...claims];
                  next[i] = { ...next[i], status: e.target.value };
                  setClaims(next);
                }}
                className="text-[10px] bg-surface border border-border rounded px-1 py-1 text-ink disabled:opacity-60"
              >
                <option value="FALSE">FALSE</option>
                <option value="UNVERIFIED">UNVERIFIED</option>
              </select>
              <input
                value={String(c.claim || '')}
                disabled={locked}
                onChange={(e) => {
                  const next = [...claims];
                  next[i] = { ...next[i], claim: e.target.value };
                  setClaims(next);
                }}
                placeholder="The circulating claim"
                className={inputCls}
              />
              <button
                type="button"
                disabled={locked}
                onClick={() => setClaims(claims.filter((_, j) => j !== i))}
                className="text-muted hover:text-danger text-sm px-1 disabled:opacity-40"
              >
                ×
              </button>
            </div>
            <input
              value={String(c.truth || '')}
              disabled={locked}
              onChange={(e) => {
                const next = [...claims];
                next[i] = { ...next[i], truth: e.target.value };
                setClaims(next);
              }}
              placeholder="The actual truth"
              className={`${inputCls} mt-1.5`}
            />
          </div>
        ))}
        <button
          type="button"
          disabled={locked}
          onClick={() => setClaims([...claims, { claim: '', status: 'FALSE', truth: '' }])}
          className="text-xs text-brand hover:underline disabled:opacity-40"
        >
          + Add claim
        </button>
      </div>

      <div className="mt-3 flex items-center">
        <button
          onClick={save}
          disabled={locked || saving}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        >
          Save fact sheet
        </button>
        <SaveStatus saving={saving} msg={msg} error={error} />
      </div>
    </SectionCard>
  );
};

// ─── Org pages ───────────────────────────────────────────────────────────────

interface PlatformPage {
  page_name?: string;
  page_handle?: string;
  page_bio?: string;
  [k: string]: unknown;
}

const OrgPagesSection = ({
  initialState,
  saveInitialState,
  locked,
}: {
  initialState: Record<string, unknown>;
  saveInitialState: (
    mutate: (is: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  locked: boolean;
}) => {
  const orgPage = (initialState.org_page || null) as Record<string, unknown> | null;
  const multiOrgs = (orgPage?.orgs || null) as Array<Record<string, unknown>> | null;

  const [draft, setDraft] = useState<Record<string, unknown> | null>(
    orgPage ? JSON.parse(JSON.stringify(orgPage)) : null,
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  if (!orgPage || !draft) return null;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await saveInitialState((is) => ({ ...is, org_page: draft }));
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const renderPlatform = (
    label: string,
    page: PlatformPage,
    onChange: (next: PlatformPage) => void,
  ) => (
    <div className="flex-1 min-w-[220px]">
      <div className="text-[11px] font-bold text-muted mb-1">{label}</div>
      <input
        value={String(page.page_name || '')}
        disabled={locked}
        onChange={(e) => onChange({ ...page, page_name: e.target.value })}
        placeholder="Page name"
        className={inputCls}
      />
      <input
        value={String(page.page_handle || '')}
        disabled={locked}
        onChange={(e) => onChange({ ...page, page_handle: e.target.value })}
        placeholder="@handle"
        className={`${inputCls} mt-1`}
      />
      <textarea
        value={String(page.page_bio || '')}
        disabled={locked}
        rows={2}
        onChange={(e) => onChange({ ...page, page_bio: e.target.value })}
        placeholder="Bio"
        className={`${inputCls} mt-1 resize-y`}
      />
    </div>
  );

  const draftOrgs = (draft.orgs || null) as Array<Record<string, unknown>> | null;

  return (
    <SectionCard
      title="Organisation Pages"
      subtitle="Participant-facing pages. Re-seeded from these values when a session starts, so edits reach the sim."
    >
      {multiOrgs && draftOrgs ? (
        <div className="space-y-4">
          {draftOrgs.map((org, i) => (
            <div key={i} className="bg-surface border border-border rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  value={String(org.display_name || '')}
                  disabled={locked}
                  onChange={(e) => {
                    const next = [...draftOrgs];
                    next[i] = { ...next[i], display_name: e.target.value };
                    setDraft({ ...draft, orgs: next });
                  }}
                  className={`${inputCls} font-semibold max-w-[260px]`}
                  placeholder="Organisation name"
                />
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${org.role === 'antagonist' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}
                >
                  {String(org.role || 'protagonist')}
                  {org.is_primary ? ' · primary' : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {renderPlatform('Fakebook', (org.facebook || {}) as PlatformPage, (p) => {
                  const next = [...draftOrgs];
                  next[i] = { ...next[i], facebook: p };
                  setDraft({ ...draft, orgs: next });
                })}
                {renderPlatform('X', (org.x_twitter || {}) as PlatformPage, (p) => {
                  const next = [...draftOrgs];
                  next[i] = { ...next[i], x_twitter: p };
                  setDraft({ ...draft, orgs: next });
                })}
              </div>
              {org.role === 'antagonist' && (
                <>
                  <label className={`${labelCls} mt-2`}>Antagonist stance (steers its AI)</label>
                  <textarea
                    value={String(org.stance || '')}
                    disabled={locked}
                    rows={2}
                    onChange={(e) => {
                      const next = [...draftOrgs];
                      next[i] = { ...next[i], stance: e.target.value };
                      setDraft({ ...draft, orgs: next });
                    }}
                    className={`${inputCls} resize-y`}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {renderPlatform('Fakebook', (draft.facebook || {}) as PlatformPage, (p) =>
            setDraft({ ...draft, facebook: p }),
          )}
          {renderPlatform('X', (draft.x_twitter || {}) as PlatformPage, (p) =>
            setDraft({ ...draft, x_twitter: p }),
          )}
        </div>
      )}

      <div className="mt-3 flex items-center">
        <button
          onClick={save}
          disabled={locked || saving}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        >
          Save org pages
        </button>
        <SaveStatus saving={saving} msg={msg} error={error} />
      </div>
    </SectionCard>
  );
};

// ─── Injects ─────────────────────────────────────────────────────────────────

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const APPS = ['social_feed', 'email', 'news', 'group_chat', 'phone_call'];

const InjectsSection = ({
  scenarioId,
  injectList,
  setInjectList,
  teamList,
  initialState,
  locked,
}: {
  scenarioId: string;
  injectList: InjectRow[];
  setInjectList: React.Dispatch<React.SetStateAction<InjectRow[]>>;
  teamList: TeamRow[];
  initialState: Record<string, unknown>;
  locked: boolean;
}) => {
  const personas = (initialState.npc_personas || []) as PersonaShape[];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const sorted = [...injectList].sort((a, b) => {
    const at = a.trigger_time_minutes ?? Number.MAX_SAFE_INTEGER;
    const bt = b.trigger_time_minutes ?? Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  const onSaved = (updated: InjectRow) => {
    setInjectList((list) => list.map((x) => (x.id === updated.id ? updated : x)));
    setExpandedId(null);
  };

  const onDeleted = (id: string) => {
    setInjectList((list) => list.filter((x) => x.id !== id));
    setExpandedId(null);
  };

  const onCreated = (created: InjectRow) => {
    setInjectList((list) => [...list, created]);
    setAdding(false);
  };

  return (
    <SectionCard
      title={`Injects (${injectList.length})`}
      subtitle="The scheduler reads these live at fire time — edits to timing, content, author, and targeting apply to every session started after saving."
    >
      <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
        {sorted.map((inj) =>
          expandedId === inj.id ? (
            <InjectForm
              key={inj.id}
              scenarioId={scenarioId}
              inject={inj}
              personas={personas}
              teamList={teamList}
              onSaved={onSaved}
              onDeleted={onDeleted}
              onCancel={() => setExpandedId(null)}
            />
          ) : (
            <InjectCard
              key={inj.id}
              inject={inj}
              locked={locked}
              onEdit={() => setExpandedId(inj.id)}
            />
          ),
        )}
        {adding && (
          <InjectForm
            scenarioId={scenarioId}
            inject={null}
            personas={personas}
            teamList={teamList}
            onSaved={onCreated}
            onDeleted={() => undefined}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
      <div className="mt-2">
        {!locked && !adding && (
          <button
            onClick={() => {
              setAdding(true);
              setExpandedId(null);
            }}
            className="text-xs text-brand hover:underline"
          >
            + Add inject
          </button>
        )}
      </div>
    </SectionCard>
  );
};

const InjectCard = ({
  inject,
  locked,
  onEdit,
}: {
  inject: InjectRow;
  locked: boolean;
  onEdit: () => void;
}) => {
  const dc = (inject.delivery_config || {}) as Record<string, unknown>;
  const app = dc.app ? String(dc.app) : inject.type;
  const isFacebook = app === 'social_feed' && String(dc.platform ?? 'x_twitter') === 'facebook';
  const mediaUrls = (dc.media_urls || []) as string[];

  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs text-accent font-mono">
              {inject.trigger_time_minutes != null
                ? `T+${inject.trigger_time_minutes}m`
                : inject.trigger_condition
                  ? 'decision'
                  : 'conditional'}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${app === 'social_feed' ? (isFacebook ? 'bg-blue-700 text-white border border-blue-500' : 'bg-black text-white border border-border') : app === 'email' ? 'bg-blue-600 text-white' : app === 'news' ? 'bg-danger text-white' : app === 'group_chat' ? 'bg-success text-white' : 'bg-surface-2 text-ink'}`}
            >
              {app === 'social_feed'
                ? isFacebook
                  ? 'Fakebook'
                  : 'X Post'
                : app.replace(/_/g, ' ')}
            </span>
            {!!dc.author_handle && (
              <span className="text-[10px] text-muted">{String(dc.author_handle)}</span>
            )}
            {inject.severity === 'critical' && (
              <span className="text-[10px] px-1 py-0.5 bg-danger/10 text-danger rounded">
                Critical
              </span>
            )}
            {inject.generation_source === 'trainer' && (
              <span className="text-[10px] px-1 py-0.5 bg-brand/10 text-brand rounded">Edited</span>
            )}
          </div>
          <div className="text-xs text-muted font-medium">{inject.title}</div>
          <div className="text-xs text-muted mt-0.5 line-clamp-2">{inject.content}</div>
          {inject.target_teams && inject.target_teams.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {inject.target_teams.map((team, ti) => (
                <span key={ti} className="text-[10px] px-1 py-0.5 bg-surface-2 text-muted rounded">
                  {team}
                </span>
              ))}
            </div>
          )}
        </div>
        {mediaUrls.length > 0 && (
          <img
            src={mediaUrls[0]}
            alt="Inject media"
            className="w-14 h-14 object-cover rounded border border-border shrink-0"
          />
        )}
        {!locked && (
          <button onClick={onEdit} className="text-xs text-brand hover:underline shrink-0">
            Edit
          </button>
        )}
      </div>
    </div>
  );
};

const InjectForm = ({
  scenarioId,
  inject,
  personas,
  teamList,
  onSaved,
  onDeleted,
  onCancel,
}: {
  scenarioId: string;
  inject: InjectRow | null; // null = create new
  personas: PersonaShape[];
  teamList: TeamRow[];
  onSaved: (row: InjectRow) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}) => {
  const dcInit = (inject?.delivery_config || {}) as Record<string, unknown>;
  const [title, setTitle] = useState(inject?.title ?? '');
  const [content, setContent] = useState(inject?.content ?? '');
  const [time, setTime] = useState<string>(
    inject?.trigger_time_minutes != null ? String(inject.trigger_time_minutes) : '',
  );
  const [severity, setSeverity] = useState(inject?.severity ?? 'medium');
  const [requiresResponse, setRequiresResponse] = useState(!!inject?.requires_response);
  const [scope, setScope] = useState(inject?.inject_scope ?? 'universal');
  const [targetTeams, setTargetTeams] = useState<string[]>(inject?.target_teams ?? []);
  const [app, setApp] = useState(String(dcInit.app ?? 'social_feed'));
  const [platform, setPlatform] = useState(String(dcInit.platform ?? 'x_twitter'));
  const [authorHandle, setAuthorHandle] = useState(String(dcInit.author_handle ?? ''));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<string[]>((dcInit.media_urls || []) as string[]);
  const [mediaRemoved, setMediaRemoved] = useState(false);
  // Cross-team intel tagging (email injects only)
  const [intelKey, setIntelKey] = useState(String(dcInit.intel_key ?? ''));
  const [intelNeededBy, setIntelNeededBy] = useState<string[]>(
    Array.isArray(dcInit.intel_needed_by) ? (dcInit.intel_needed_by as string[]) : [],
  );
  const [intelKeywords, setIntelKeywords] = useState(
    Array.isArray(dcInit.detection_keywords)
      ? (dcInit.detection_keywords as string[]).join(', ')
      : '',
  );
  const [intelSummary, setIntelSummary] = useState(String(dcInit.intel_summary ?? ''));

  const contentChanged =
    inject !== null &&
    (content !== inject.content || authorHandle !== String(dcInit.author_handle ?? ''));
  const imageStale = contentChanged && mediaUrls.length > 0;

  const buildDeliveryConfig = (): Record<string, unknown> => {
    const persona = personas.find((p) => String(p.handle || '') === authorHandle);
    const dc: Record<string, unknown> = {
      ...dcInit,
      app,
      platform: app === 'social_feed' ? platform : dcInit.platform,
      author_handle: authorHandle || dcInit.author_handle,
      ...(persona ? { author_display_name: String(persona.name || '') } : {}),
    };
    if (mediaRemoved) dc.media_urls = [];
    else if (mediaUrls.length > 0) dc.media_urls = mediaUrls;
    // Cross-team intel tagging: only meaningful on emails; clearing the key
    // removes the whole tag so detection and gates stop referencing it.
    if (app === 'email' && intelKey.trim()) {
      dc.intel_key = intelKey
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      dc.intel_needed_by = intelNeededBy;
      dc.detection_keywords = intelKeywords
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      dc.intel_summary = intelSummary.trim();
    } else {
      delete dc.intel_key;
      delete dc.intel_needed_by;
      delete dc.detection_keywords;
      delete dc.intel_summary;
    }
    return dc;
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const fields: Record<string, unknown> = {
        title,
        content,
        severity,
        requires_response: requiresResponse,
        inject_scope: scope,
        target_teams: scope === 'team_specific' ? targetTeams : [],
        trigger_time_minutes: time.trim() === '' ? null : Number(time),
        delivery_config: buildDeliveryConfig(),
      };
      if (inject === null) {
        fields.type = app === 'social_feed' ? 'social_post' : app;
        const res = await api.scenarios.createInject(scenarioId, fields);
        onSaved(res.data as unknown as InjectRow);
      } else {
        const res = await api.scenarios.updateInject(scenarioId, inject.id, fields);
        onSaved(res.data as unknown as InjectRow);
      }
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!inject) return;
    if (!window.confirm(`Delete inject "${inject.title}"? This cannot be undone.`)) return;
    setDeleting(true);
    setMsg(null);
    try {
      await api.scenarios.deleteInject(scenarioId, inject.id);
      onDeleted(inject.id);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
      setDeleting(false);
    }
  };

  const regenerateImage = async () => {
    if (!inject) return;
    setRegenerating(true);
    setMsg(null);
    try {
      // Persist current edits first so the image is generated from what will
      // actually fire, then regenerate.
      const fields: Record<string, unknown> = {
        title,
        content,
        severity,
        requires_response: requiresResponse,
        inject_scope: scope,
        target_teams: scope === 'team_specific' ? targetTeams : [],
        trigger_time_minutes: time.trim() === '' ? null : Number(time),
        delivery_config: buildDeliveryConfig(),
      };
      await api.scenarios.updateInject(scenarioId, inject.id, fields);
      const res = await api.scenarios.regenerateInjectImage(scenarioId, inject.id);
      const updated = res.data as unknown as InjectRow;
      const newDc = (updated.delivery_config || {}) as Record<string, unknown>;
      setMediaUrls((newDc.media_urls || []) as string[]);
      setMediaRemoved(false);
      setMsg('Image regenerated');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setRegenerating(false);
    }
  };

  const toggleTeam = (name: string) => {
    setTargetTeams((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  };

  return (
    <div className="bg-surface border border-brand/40 rounded-lg p-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={labelCls}>Trigger time (min)</label>
            <input
              type="number"
              min={0}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder={inject?.trigger_condition ? 'decision-driven' : 'empty = conditional'}
              className={inputCls}
            />
          </div>
          <div className="flex-1">
            <label className={labelCls}>Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className={inputCls}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <label className={`${labelCls} mt-2`}>Content</label>
      <textarea
        value={content}
        rows={3}
        onChange={(e) => setContent(e.target.value)}
        className={`${inputCls} resize-y`}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
        <div>
          <label className={labelCls}>Delivery app</label>
          <select value={app} onChange={(e) => setApp(e.target.value)} className={inputCls}>
            {APPS.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        {app === 'social_feed' && (
          <div>
            <label className={labelCls}>Platform</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className={inputCls}
            >
              <option value="x_twitter">X</option>
              <option value="facebook">Fakebook</option>
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Author</label>
          <select
            value={
              personas.some((p) => String(p.handle || '') === authorHandle)
                ? authorHandle
                : '__custom'
            }
            onChange={(e) => {
              if (e.target.value !== '__custom') setAuthorHandle(e.target.value);
            }}
            className={inputCls}
          >
            <option value="">(random persona)</option>
            {personas.map((p, i) => (
              <option key={i} value={String(p.handle || '')}>
                {String(p.name)} ({String(p.handle)})
              </option>
            ))}
            <option value="__custom">custom…</option>
          </select>
          <input
            value={authorHandle}
            onChange={(e) => setAuthorHandle(e.target.value)}
            placeholder="@handle"
            className={`${inputCls} mt-1`}
          />
        </div>
      </div>

      {app === 'email' && (
        <div className="mt-2 border border-border rounded p-2 bg-surface-2">
          <label className={labelCls}>Cross-team intel (optional)</label>
          <p className="text-[10px] text-muted mb-1.5">
            Tag this email as carrying a fact another team needs. Detection keywords are matched
            when players relay it; paired gates use conditions <code>intel_shared:&lt;key&gt;</code>{' '}
            / <code>intel_missing:&lt;key&gt;</code>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Intel key</label>
              <input
                value={intelKey}
                onChange={(e) => setIntelKey(e.target.value)}
                placeholder="e.g. supplier_batch_confirmation"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Needed by</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {teamList.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setIntelNeededBy((prev) =>
                        prev.includes(t.team_name)
                          ? prev.filter((n) => n !== t.team_name)
                          : [...prev, t.team_name],
                      )
                    }
                    className={`text-[10px] px-2 py-1 rounded border ${intelNeededBy.includes(t.team_name) ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-border'}`}
                  >
                    {t.team_name}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            <div>
              <label className={labelCls}>Detection keywords (comma-separated)</label>
              <input
                value={intelKeywords}
                onChange={(e) => setIntelKeywords(e.target.value)}
                placeholder="batch 4471, eastern region, SG-Recall-7"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Trainer summary</label>
              <input
                value={intelSummary}
                onChange={(e) => setIntelSummary(e.target.value)}
                placeholder="Why another team needs this"
                className={inputCls}
              />
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
        <div>
          <label className={labelCls}>Audience</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} className={inputCls}>
            <option value="universal">All teams</option>
            <option value="team_specific">Specific teams</option>
          </select>
          {scope === 'team_specific' && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {teamList.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTeam(t.team_name)}
                  className={`text-[10px] px-2 py-1 rounded border ${targetTeams.includes(t.team_name) ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-border'}`}
                >
                  {t.team_name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={requiresResponse}
              onChange={(e) => setRequiresResponse(e.target.checked)}
            />
            Requires participant response
          </label>
        </div>
      </div>

      {/* Attached image + regenerate / remove */}
      {inject !== null && (mediaUrls.length > 0 || regenerating) && !mediaRemoved && (
        <div className="mt-3 bg-surface-2 border border-border rounded p-2 flex items-center gap-3">
          {mediaUrls.length > 0 && (
            <img
              src={mediaUrls[0]}
              alt="Inject media"
              className="w-16 h-16 object-cover rounded border border-border"
            />
          )}
          <div className="flex-1">
            <div className="text-[11px] text-muted">
              Attached image (delivered with the post).
              {imageStale && (
                <span className="text-warning font-medium">
                  {' '}
                  You changed the content/author — the image may no longer match.
                </span>
              )}
            </div>
            <div className="flex gap-3 mt-1">
              <button
                type="button"
                onClick={regenerateImage}
                disabled={regenerating || saving}
                className="text-xs text-brand hover:underline disabled:opacity-40"
              >
                {regenerating ? 'Regenerating…' : 'Regenerate image'}
              </button>
              <button
                type="button"
                onClick={() => setMediaRemoved(true)}
                disabled={regenerating || saving}
                className="text-xs text-muted hover:text-danger disabled:opacity-40"
              >
                Remove image
              </button>
            </div>
          </div>
        </div>
      )}
      {mediaRemoved && (
        <div className="mt-2 text-[11px] text-muted">
          Image will be removed on save.{' '}
          <button
            type="button"
            onClick={() => setMediaRemoved(false)}
            className="text-brand hover:underline"
          >
            Undo
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={save}
          disabled={saving || deleting || regenerating || !title.trim() || !content.trim()}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        >
          {saving ? 'Saving…' : inject === null ? 'Create inject' : 'Save inject'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving || deleting || regenerating}
          className="text-xs px-3 py-1.5 border border-border rounded text-muted"
        >
          Cancel
        </button>
        {inject !== null && (
          <button
            onClick={remove}
            disabled={saving || deleting || regenerating}
            className="text-xs px-3 py-1.5 text-danger hover:underline ml-auto disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Delete inject'}
          </button>
        )}
        <SaveStatus saving={false} msg={msg} error={error} />
      </div>
    </div>
  );
};

// ─── Team charters ───────────────────────────────────────────────────────────

const TeamsSection = ({
  scenarioId,
  teamList,
  setTeamList,
  locked,
}: {
  scenarioId: string;
  teamList: TeamRow[];
  setTeamList: React.Dispatch<React.SetStateAction<TeamRow[]>>;
  locked: boolean;
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mission, setMission] = useState('');
  const [responsibilities, setResponsibilities] = useState<string[]>([]);
  const [outOfLane, setOutOfLane] = useState<string[]>([]);
  const [rubric, setRubric] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const startEdit = (t: TeamRow) => {
    setEditingId(t.id);
    setMission(t.charter?.mission || t.team_description || '');
    setResponsibilities([...(t.charter?.responsibilities || [])]);
    setOutOfLane([...(t.charter?.out_of_lane || [])]);
    setRubric(t.scoring_rubric || '');
    setMsg(null);
  };

  const save = async (t: TeamRow) => {
    setSaving(true);
    setMsg(null);
    try {
      const fields = {
        team_description: mission,
        charter: {
          mission,
          responsibilities: responsibilities.map((r) => r.trim()).filter(Boolean),
          out_of_lane: outOfLane.map((r) => r.trim()).filter(Boolean),
        },
        scoring_rubric: rubric,
      };
      const res = await api.scenarios.updateTeam(scenarioId, t.id, fields);
      setTeamList((list) =>
        list.map((x) =>
          x.id === t.id ? ({ ...x, ...(res.data as Partial<TeamRow>) } as TeamRow) : x,
        ),
      );
      setEditingId(null);
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  if (teamList.length === 0) return null;

  return (
    <SectionCard
      title="Team Charters"
      subtitle="Grading and scoring read these live. Team names and expected actions are fixed (they drive action detection); the wording is yours."
    >
      <div className="space-y-3">
        {teamList.map((t) =>
          editingId === t.id ? (
            <div key={t.id} className="bg-surface border border-brand/40 rounded-lg p-3">
              <div className="text-sm font-semibold text-ink mb-2">{t.team_name}</div>
              <label className={labelCls}>Mission</label>
              <textarea
                value={mission}
                rows={2}
                onChange={(e) => setMission(e.target.value)}
                className={`${inputCls} resize-y`}
              />
              <label className={`${labelCls} mt-2`}>Responsibilities</label>
              <StringListEditor
                items={responsibilities}
                onChange={setResponsibilities}
                disabled={false}
                addLabel="Add responsibility"
              />
              <label className={`${labelCls} mt-2`}>Out of lane (what this team must NOT do)</label>
              <StringListEditor
                items={outOfLane}
                onChange={setOutOfLane}
                disabled={false}
                addLabel="Add out-of-lane rule"
              />
              <label className={`${labelCls} mt-2`}>
                Scoring rubric (how the AI grades this team's output)
              </label>
              <textarea
                value={rubric}
                rows={3}
                onChange={(e) => setRubric(e.target.value)}
                className={`${inputCls} resize-y`}
              />
              <div className="flex gap-2 mt-2 items-center">
                <button
                  onClick={() => save(t)}
                  disabled={saving || !mission.trim()}
                  className="text-xs px-3 py-1 bg-brand text-white rounded disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save charter'}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  disabled={saving}
                  className="text-xs px-3 py-1 border border-border rounded text-muted"
                >
                  Cancel
                </button>
                <SaveStatus saving={false} msg={msg} error={error} />
              </div>
            </div>
          ) : (
            <div key={t.id} className="bg-surface border border-border rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-ink">{t.team_name}</div>
                {!locked && (
                  <button
                    onClick={() => startEdit(t)}
                    className="text-xs text-brand hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
              <div className="text-xs text-muted mt-1">
                {t.charter?.mission || t.team_description}
              </div>
              {(t.charter?.responsibilities?.length ?? 0) > 0 && (
                <ul className="text-[11px] text-muted mt-1.5 list-disc pl-4 space-y-0.5">
                  {t.charter!.responsibilities!.slice(0, 6).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {(t.expected_actions?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {t.expected_actions!.map((a, i) => (
                    <span
                      key={i}
                      className="text-[10px] px-1.5 py-0.5 bg-surface-2 text-muted rounded"
                      title="Expected actions are fixed — they drive scoring detection"
                    >
                      {String(a.description || a.action_id)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </SectionCard>
  );
};

// ─── Objectives ──────────────────────────────────────────────────────────────

const ObjectivesSection = ({
  scenarioId,
  objectiveList,
  setObjectiveList,
  locked,
}: {
  scenarioId: string;
  objectiveList: ObjectiveRow[];
  setObjectiveList: React.Dispatch<React.SetStateAction<ObjectiveRow[]>>;
  locked: boolean;
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [weight, setWeight] = useState('25');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const save = async (o: ObjectiveRow) => {
    setSaving(true);
    setMsg(null);
    try {
      const fields = {
        objective_name: name,
        description,
        weight: Number(weight) || 0,
      };
      const res = await api.scenarios.updateObjective(scenarioId, o.id, fields);
      setObjectiveList((list) =>
        list.map((x) =>
          x.id === o.id ? ({ ...x, ...(res.data as Partial<ObjectiveRow>) } as ObjectiveRow) : x,
        ),
      );
      setEditingId(null);
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  if (objectiveList.length === 0) return null;

  return (
    <SectionCard
      title={`Objectives (${objectiveList.length})`}
      subtitle="Materialised into session scoring when a session starts — edit before launch."
    >
      <div className="space-y-2">
        {objectiveList.map((o) =>
          editingId === o.id ? (
            <div key={o.id} className="bg-surface border border-brand/40 rounded-lg p-3">
              <label className={labelCls}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
              <label className={`${labelCls} mt-1.5`}>Description</label>
              <textarea
                value={description}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                className={`${inputCls} resize-y`}
              />
              <label className={`${labelCls} mt-1.5`}>Weight (%)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className={`${inputCls} max-w-[100px]`}
              />
              <div className="flex gap-2 mt-2 items-center">
                <button
                  onClick={() => save(o)}
                  disabled={saving || !name.trim()}
                  className="text-xs px-3 py-1 bg-brand text-white rounded disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  disabled={saving}
                  className="text-xs px-3 py-1 border border-border rounded text-muted"
                >
                  Cancel
                </button>
                <SaveStatus saving={false} msg={msg} error={error} />
              </div>
            </div>
          ) : (
            <div
              key={o.id}
              className="bg-surface border border-border rounded-lg p-3 flex items-start gap-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-ink">
                  {o.objective_name}{' '}
                  <span className="text-muted font-normal">({Number(o.weight)}%)</span>
                </div>
                {o.description && (
                  <div className="text-[11px] text-muted mt-0.5">{o.description}</div>
                )}
              </div>
              {!locked && (
                <button
                  onClick={() => {
                    setEditingId(o.id);
                    setName(o.objective_name);
                    setDescription(o.description || '');
                    setWeight(String(o.weight));
                    setMsg(null);
                  }}
                  className="text-xs text-brand hover:underline shrink-0"
                >
                  Edit
                </button>
              )}
            </div>
          ),
        )}
      </div>
    </SectionCard>
  );
};

// ─── Research guidelines ─────────────────────────────────────────────────────

interface GuidelineShape {
  best_practice?: string;
  source_basis?: string;
  [k: string]: unknown;
}

const ResearchGuidelinesSection = ({
  initialState,
  saveInitialState,
  locked,
}: {
  initialState: Record<string, unknown>;
  saveInitialState: (
    mutate: (is: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  locked: boolean;
}) => {
  const research = (initialState.research_guidelines || {}) as Record<string, unknown>;
  const [perTeam, setPerTeam] = useState<Array<Record<string, unknown>>>(
    JSON.parse(JSON.stringify((research.per_team || []) as Array<Record<string, unknown>>)),
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  if (perTeam.length === 0) return null;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await saveInitialState((is) => ({
        ...is,
        research_guidelines: {
          ...((is.research_guidelines || {}) as Record<string, unknown>),
          per_team: perTeam,
        },
      }));
      setMsg('Saved');
      setError(false);
    } catch (err) {
      setMsg((err as Error).message);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Research Guidelines"
      subtitle="The content grader scores participant posts against these best practices."
    >
      {perTeam.map((team, ti) => {
        const guidelines = (team.guidelines || []) as GuidelineShape[];
        return (
          <div key={ti} className="mb-3">
            <h4 className="text-xs font-bold text-ink mb-1">{String(team.team_name)}</h4>
            <div className="space-y-1.5">
              {guidelines.map((g, gi) => (
                <div key={gi} className="flex gap-1.5 items-start">
                  <textarea
                    value={String(g.best_practice || '')}
                    disabled={locked}
                    rows={2}
                    onChange={(e) => {
                      const nextTeams = [...perTeam];
                      const nextGuides = [...guidelines];
                      nextGuides[gi] = { ...nextGuides[gi], best_practice: e.target.value };
                      nextTeams[ti] = { ...nextTeams[ti], guidelines: nextGuides };
                      setPerTeam(nextTeams);
                    }}
                    className={`${inputCls} resize-y`}
                  />
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      const nextTeams = [...perTeam];
                      nextTeams[ti] = {
                        ...nextTeams[ti],
                        guidelines: guidelines.filter((_, j) => j !== gi),
                      };
                      setPerTeam(nextTeams);
                    }}
                    className="text-muted hover:text-danger text-sm px-1 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  const nextTeams = [...perTeam];
                  nextTeams[ti] = {
                    ...nextTeams[ti],
                    guidelines: [
                      ...guidelines,
                      { best_practice: '', source_basis: 'Trainer-added' },
                    ],
                  };
                  setPerTeam(nextTeams);
                }}
                className="text-xs text-brand hover:underline disabled:opacity-40"
              >
                + Add guideline
              </button>
            </div>
          </div>
        );
      })}
      <div className="mt-2 flex items-center">
        <button
          onClick={save}
          disabled={locked || saving}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded disabled:opacity-40"
        >
          Save guidelines
        </button>
        <SaveStatus saving={saving} msg={msg} error={error} />
      </div>
    </SectionCard>
  );
};
