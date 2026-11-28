import { useEffect, useState } from 'react';
import type { ConditionDefSpec } from '@shared/conditionKeyGrammar';
import { slugifyTeamName } from '@shared/conditionKeyGrammar';
import { isInjectKey, uniqueInjectKey } from '@shared/injectKeySlug';
import {
  DEPENDENCY_KINDS,
  DEPENDENCY_SEVERITIES,
  conditionGroupKeys,
  consequenceInjectDraft,
  displayRef,
  matchTeamRef,
  toEditorModel,
  type ActiveTeam,
  type DependencyEditorModel,
  type DependencyKind,
  type DependencySeverity,
  type TeamDependencyEdge,
  type TeamRef,
} from '@shared/teamDependencies';
import { api } from '../../lib/api';
import { buildDependencyEdge } from './dependencyEdgeDraft';
import { formatSaveError } from './dependencyDocument';
import { readScenarioInject, type ScenarioInjectRow } from './scenarioInject';
import { ConditionBuilder, type InjectChoice } from './ConditionBuilder';
import {
  compileDraft,
  draftFromStored,
  emptyConditionNames,
  emptyDraft,
  newConditionRow,
  type ConditionDraft,
  type ConditionNames,
} from './conditionDraft';
import { dependencyPreviewSentence } from './dependencyPreview';

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60';
const labelCls = 'text-[11px] text-muted font-medium block mb-0.5';

export interface DrawerInject {
  id: string;
  title: string;
  trigger_time_minutes: number | null;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config?: Record<string, unknown> | null;
}

interface StakeholderChoice {
  id: string;
  name: string;
}

function teamValue(team: ActiveTeam): string {
  return team.team_uid ? `uid:${team.team_uid}` : `name:${slugifyTeamName(team.team_name)}`;
}

function refValue(ref: TeamRef, teams: readonly ActiveTeam[]): string {
  const match = matchTeamRef(ref, teams);
  return match && match.playable !== false ? teamValue(match) : '';
}

function refFromValue(value: string, teams: readonly ActiveTeam[]): TeamRef | null {
  const team = teams.find((item) => teamValue(item) === value);
  if (!team || team.playable === false) return null;
  return { team_uid: team.team_uid ?? null, team_name: team.team_name };
}

function blankModel(): DependencyEditorModel {
  return {
    id: '',
    kind: 'information',
    upstream: { team_uid: null, team_name: '' },
    downstream: [],
    deliverable: '',
    why: '',
    dueMode: 'by_minute',
    byMinute: 15,
    afterInjectKey: '',
    withinMinutes: 10,
    broken: { quantifier: 'any', threshold: 1, keys: [] },
    met: null,
    lagMinutes: 5,
    severity: 'medium',
    consequenceKeys: [],
    source: 'trainer',
  };
}

function injectKeyOf(inject: DrawerInject): string | null {
  const key = inject.delivery_config?.inject_key;
  return typeof key === 'string' && isInjectKey(key) ? key : null;
}

export function DependencyDrawer({
  scenarioId,
  edge,
  teams,
  injects,
  stakeholders,
  durationMinutes,
  takenDependencyIds,
  locked,
  onClose,
  onCommit,
  onInjectCreated,
  onInjectUpdated,
}: {
  scenarioId: string;
  edge: TeamDependencyEdge | null;
  teams: readonly ActiveTeam[];
  injects: readonly DrawerInject[];
  stakeholders: readonly StakeholderChoice[];
  durationMinutes: number;
  takenDependencyIds: ReadonlySet<string>;
  locked: boolean;
  onClose: () => void;
  onCommit: (edge: TeamDependencyEdge) => Promise<void>;
  onInjectCreated: (row: ScenarioInjectRow) => void;
  onInjectUpdated: (row: ScenarioInjectRow) => void;
}) {
  const playable = teams.filter((team) => team.playable !== false);
  const [model, setModel] = useState<DependencyEditorModel>(() =>
    edge ? toEditorModel(edge) : blankModel(),
  );
  const [upstreamValue, setUpstreamValue] = useState(() =>
    edge ? refValue(edge.upstream, playable) : '',
  );
  const [downstreamValues, setDownstreamValues] = useState<string[]>(() => {
    if (!edge) return [''];
    const values = edge.downstream.map((ref) => refValue(ref, playable));
    return values.length > 0 ? values : [''];
  });
  const [catalog, setCatalog] = useState<ConditionDefSpec[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [broken, setBroken] = useState<ConditionDraft | null>(null);
  const [met, setMet] = useState<ConditionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.scenarios
      .getConditionCatalog(scenarioId)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.data.defs.filter((def) => !def.id.startsWith('dependency_')));
        setCatalogError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setCatalogError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  useEffect(() => {
    if (!catalog || broken) return;
    const options = { allowPlaceholders: true as const };
    if (edge) {
      setBroken(draftFromStored(edge.broken_when, [], null, catalog, options));
      setMet(draftFromStored(edge.met_when ?? { all: [] }, [], null, catalog, options));
      return;
    }
    const row = newConditionRow(catalog, 'cross');
    const def = catalog.find((item) => item.id === row.event);
    const seeded = def?.teamScope ? { ...row, team: '@upstream', role: '' } : row;
    setBroken({ ...emptyDraft(), quantifier: 'any', appear: [seeded] });
    setMet({ ...emptyDraft(), quantifier: 'any', appear: [] });
  }, [catalog, broken, edge]);

  const choices: InjectChoice[] = injects.map((inject) => ({
    id: inject.id,
    title: inject.title,
    injectKey: injectKeyOf(inject),
    triggerTime: inject.trigger_time_minutes,
  }));
  const names: ConditionNames = {
    ...emptyConditionNames(),
    injectTitle: (key) => choices.find((item) => item.injectKey === key)?.title,
    stakeholderName: (id) => stakeholders.find((item) => item.id === id)?.name,
    teamName: (slug) => {
      if (slug === '@upstream') return 'upstream team';
      if (slug === '@downstream') return 'downstream team';
      return teams.find((team) => slugifyTeamName(team.team_name) === slug)?.team_name;
    },
  };
  const timedRefs = choices.flatMap((inject) =>
    inject.injectKey
      ? [
          {
            inject_key: inject.injectKey,
            title: inject.title,
            trigger_time_minutes: inject.triggerTime,
          },
        ]
      : [],
  );
  const brokenCompiled =
    catalog && broken
      ? compileDraft(broken, catalog, names, [], timedRefs, { allowPlaceholders: true })
      : null;
  const metCompiled =
    catalog && met
      ? compileDraft(met, catalog, names, [], timedRefs, {
          allowPlaceholders: true,
          allowEmpty: true,
        })
      : null;

  const upstream = refFromValue(upstreamValue, playable);
  const downstream = downstreamValues.flatMap((value) => {
    const ref = refFromValue(value, playable);
    return ref ? [ref] : [];
  });
  const brokenKeys = brokenCompiled ? conditionGroupKeys(brokenCompiled.conditions_to_appear) : [];
  const metKeys =
    metCompiled && met && met.appear.length > 0
      ? conditionGroupKeys(metCompiled.conditions_to_appear)
      : [];
  const preview =
    upstream && downstream.length > 0 && model.deliverable.trim()
      ? dependencyPreviewSentence({
          upstream: upstream.team_name,
          downstream: downstream.map((team) => team.team_name),
          brokenKeys,
          brokenQuantifier: broken?.quantifier === 'all' ? 'all' : 'any',
          metKeys,
          lagMinutes: model.lagMinutes,
          consequences: model.consequenceKeys.map((key) => ({
            title: choices.find((item) => item.injectKey === key)?.title || key,
          })),
          injectTitles: Object.fromEntries(
            choices.flatMap((item) => (item.injectKey ? [[item.injectKey, item.title]] : [])),
          ),
        })
      : '';

  const takenInjectKeys = () => {
    const taken = new Set<string>();
    for (const inject of injects) {
      const key = injectKeyOf(inject);
      if (key) taken.add(key);
    }
    return taken;
  };

  const buildEdge = (): { edge: TeamDependencyEdge } | { error: string } =>
    buildDependencyEdge({
      model,
      upstream,
      downstream,
      brokenKeys,
      brokenQuantifier:
        broken?.quantifier === 'at_least' ? 'at_least' : broken?.quantifier === 'all' ? 'all' : 'any',
      brokenThreshold: broken?.threshold ?? 1,
      metKeys,
      metQuantifier: met?.quantifier === 'at_least' ? 'at_least' : met?.quantifier === 'all' ? 'all' : 'any',
      metThreshold: met?.threshold ?? 1,
      brokenError:
        brokenCompiled == null
          ? 'Breaks when is incomplete.'
          : brokenCompiled.errors.length > 0
            ? (brokenCompiled.errors[0] ?? 'Breaks when is incomplete.')
            : null,
      metError: metCompiled && metCompiled.errors.length > 0 ? (metCompiled.errors[0] ?? null) : null,
      durationMinutes,
      takenIds: takenDependencyIds,
      source: edge?.source ?? 'trainer',
    });

  const save = async (next: TeamDependencyEdge) => {
    setSaving(true);
    setMessage(null);
    try {
      await onCommit(next);
      setModel(toEditorModel(next));
      setMessage('Saved');
      setError(false);
      return true;
    } catch (err) {
      setMessage(formatSaveError(err));
      setError(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    const built = buildEdge();
    if ('error' in built) {
      setMessage(built.error);
      setError(true);
      return;
    }
    await save(built.edge);
  };

  const addConsequence = async (ref: TeamRef) => {
    const built = buildEdge();
    if ('error' in built) {
      setMessage(built.error);
      setError(true);
      return;
    }
    const name = displayRef(ref, teams).name;
    const key = uniqueInjectKey(`Consequence for ${name}`, takenInjectKeys());
    const sentence = dependencyPreviewSentence({
      upstream: built.edge.upstream.team_name,
      downstream: [name],
      brokenKeys,
      brokenQuantifier: broken?.quantifier === 'all' ? 'all' : 'any',
      metKeys,
      lagMinutes: built.edge.lag_minutes,
      consequences: [{ team: name, title: `Consequence for ${name}` }],
    });
    setSaving(true);
    setMessage(null);
    try {
      const created = await api.scenarios.createInject(
        scenarioId,
        consequenceInjectDraft({
          edge: built.edge,
          team: name,
          injectKey: key,
          title: `Consequence for ${name}`,
          content: sentence,
        }),
      );
      const row = readScenarioInject(created.data);
      if (!row) throw new Error('The consequence inject came back without an id.');
      onInjectCreated(row);
      const withKey: TeamDependencyEdge = {
        ...built.edge,
        consequence_keys: [...built.edge.consequence_keys, key],
      };
      await save(withKey);
    } catch (err) {
      setMessage(formatSaveError(err));
      setError(true);
      setSaving(false);
    }
  };

  const assignInjectKey = async (injectId: string): Promise<string> => {
    const target = injects.find((item) => item.id === injectId);
    if (!target) throw new Error('That inject is not on this scenario');
    const key = uniqueInjectKey(target.title, takenInjectKeys());
    const config = { ...(target.delivery_config ?? {}), inject_key: key };
    const res = await api.scenarios.updateInject(scenarioId, injectId, { delivery_config: config });
    const row = readScenarioInject(res.data);
    if (!row) throw new Error('That inject came back without an id.');
    onInjectUpdated(row);
    return key;
  };

  const patch = (partial: Partial<DependencyEditorModel>) =>
    setModel((current) => ({ ...current, ...partial }));

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-section="dependency-drawer">
      <button
        type="button"
        className="absolute inset-0 bg-ink/30"
        aria-label="Close dependency editor"
        onClick={onClose}
      />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto bg-surface border-l border-border shadow-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-ink">
            {edge ? 'Edit dependency' : 'Add dependency'}
          </h2>
          <button
            type="button"
            className="ml-auto text-xs text-muted hover:text-ink"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={labelCls}>
            Upstream (owes)
            <select
              aria-label="Upstream team"
              className={`${inputCls} mt-0.5`}
              value={upstreamValue}
              disabled={locked}
              onChange={(event) => setUpstreamValue(event.target.value)}
            >
              <option value="">Choose team</option>
              {playable.map((team) => (
                <option key={teamValue(team)} value={teamValue(team)}>
                  {team.team_name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Kind
            <select
              aria-label="Dependency kind"
              className={`${inputCls} mt-0.5`}
              value={model.kind}
              disabled={locked}
              onChange={(event) => patch({ kind: event.target.value as DependencyKind })}
            >
              {DEPENDENCY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-2">
          <span className={labelCls}>Downstream (needs)</span>
          <div className="space-y-1">
            {downstreamValues.map((value, index) => (
              <div key={index} className="flex gap-1">
                <select
                  aria-label={`Downstream team ${index + 1}`}
                  className={inputCls}
                  value={value}
                  disabled={locked}
                  onChange={(event) =>
                    setDownstreamValues((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item,
                      ),
                    )
                  }
                >
                  <option value="">Choose team</option>
                  {playable.map((team) => (
                    <option key={teamValue(team)} value={teamValue(team)}>
                      {team.team_name}
                    </option>
                  ))}
                </select>
                {downstreamValues.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-muted px-1"
                    disabled={locked}
                    onClick={() =>
                      setDownstreamValues((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {downstreamValues.length < 3 && (
              <button
                type="button"
                className="text-xs text-brand hover:underline"
                disabled={locked}
                onClick={() => setDownstreamValues((current) => [...current, ''])}
              >
                + Add downstream team
              </button>
            )}
          </div>
        </div>

        <label className={`${labelCls} mt-2`}>
          Deliverable
          <input
            aria-label="Deliverable"
            className={`${inputCls} mt-0.5`}
            value={model.deliverable}
            disabled={locked}
            onChange={(event) => patch({ deliverable: event.target.value })}
          />
        </label>
        <label className={`${labelCls} mt-2`}>
          Why
          <textarea
            aria-label="Why this dependency matters"
            className={`${inputCls} mt-0.5 resize-y`}
            rows={2}
            value={model.why}
            disabled={locked}
            onChange={(event) => patch({ why: event.target.value })}
          />
        </label>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={labelCls}>
            Due
            <select
              aria-label="Due kind"
              className={`${inputCls} mt-0.5`}
              value={model.dueMode}
              disabled={locked}
              onChange={(event) =>
                patch({
                  dueMode: event.target.value === 'after_inject' ? 'after_inject' : 'by_minute',
                })
              }
            >
              <option value="by_minute">By minute</option>
              <option value="after_inject">After an inject</option>
            </select>
          </label>
          {model.dueMode === 'by_minute' ? (
            <label className={labelCls}>
              Minute
              <input
                aria-label="Due minute"
                type="number"
                min={0}
                className={`${inputCls} mt-0.5 w-24`}
                value={model.byMinute}
                disabled={locked}
                onChange={(event) => patch({ byMinute: Number(event.target.value) })}
              />
            </label>
          ) : (
            <>
              <label className={labelCls}>
                After
                <select
                  aria-label="Due after inject"
                  className={`${inputCls} mt-0.5`}
                  value={model.afterInjectKey}
                  disabled={locked}
                  onChange={(event) => patch({ afterInjectKey: event.target.value })}
                >
                  <option value="">Choose inject</option>
                  {choices.flatMap((inject) =>
                    inject.injectKey ? (
                      <option key={inject.id} value={inject.injectKey}>
                        {inject.title || inject.injectKey}
                      </option>
                    ) : (
                      []
                    ),
                  )}
                </select>
              </label>
              <label className={labelCls}>
                Within minutes
                <input
                  aria-label="Due within minutes"
                  type="number"
                  min={0}
                  className={`${inputCls} mt-0.5 w-24`}
                  value={model.withinMinutes}
                  disabled={locked}
                  onChange={(event) => patch({ withinMinutes: Number(event.target.value) })}
                />
              </label>
            </>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={labelCls}>
            Lag (minutes)
            <input
              aria-label="Lag minutes"
              type="number"
              min={0}
              max={30}
              className={`${inputCls} mt-0.5 w-24`}
              value={model.lagMinutes}
              disabled={locked}
              onChange={(event) => patch({ lagMinutes: Number(event.target.value) })}
            />
          </label>
          <label className={labelCls}>
            Severity
            <select
              aria-label="Severity"
              className={`${inputCls} mt-0.5`}
              value={model.severity}
              disabled={locked}
              onChange={(event) => patch({ severity: event.target.value as DependencySeverity })}
            >
              {DEPENDENCY_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <div className="text-[11px] text-muted font-medium">Breaks when</div>
          {catalogError && <p className="text-[11px] text-danger mt-1">{catalogError}</p>}
          {!catalog && !catalogError && (
            <p className="text-[11px] text-muted mt-1">Loading the condition catalogue…</p>
          )}
          {catalog && broken && (
            <ConditionBuilder
              defs={catalog}
              draft={broken}
              onChange={setBroken}
              injects={choices}
              stakeholders={stakeholders}
              teams={playable.flatMap((team) => {
                const slug = slugifyTeamName(team.team_name);
                return slug ? [{ name: team.team_name, slug }] : [];
              })}
              roles={[]}
              names={names}
              extraKeys={[]}
              onAssignInjectKey={assignInjectKey}
              fixedTeamScope="@upstream"
              appearOnly
            />
          )}
        </div>

        <div className="mt-3">
          <div className="text-[11px] text-muted font-medium">Resolved when</div>
          {catalog && met && (
            <ConditionBuilder
              defs={catalog}
              draft={met}
              onChange={setMet}
              injects={choices}
              stakeholders={stakeholders}
              teams={[]}
              roles={[]}
              names={names}
              extraKeys={[]}
              onAssignInjectKey={assignInjectKey}
              fixedTeamScope="@upstream"
              appearOnly
              allowEmpty
              emptyLabel="No conditions — the dependency can only be broken or pending."
            />
          )}
        </div>

        <div className="mt-3" data-section="dependency-consequences">
          <div className="text-[11px] text-muted font-medium mb-1">Consequences</div>
          {model.consequenceKeys.length === 0 && (
            <p className="text-[11px] text-muted">No consequence injects yet.</p>
          )}
          <ul className="space-y-1">
            {model.consequenceKeys.map((key) => {
              const title = choices.find((item) => item.injectKey === key)?.title;
              return (
                <li key={key} className="text-xs text-ink">
                  {title || key}
                  {title ? ' (✓)' : ''}
                </li>
              );
            })}
          </ul>
          <div className="mt-1 space-y-1">
            {downstream.map((ref) => (
              <button
                key={ref.team_uid || ref.team_name}
                type="button"
                className="block text-xs text-brand hover:underline disabled:opacity-40"
                disabled={locked || saving}
                onClick={() => addConsequence(ref)}
              >
                + Add consequence for {ref.team_name}
              </button>
            ))}
          </div>
        </div>

        {preview && (
          <p className="mt-3 text-[11px] text-ink" data-section="dependency-preview">
            {preview}
          </p>
        )}
        {message && (
          <p className={`mt-2 text-[11px] ${error ? 'text-danger' : 'text-success'}`}>{message}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="wr-btn sm accent"
            disabled={locked || saving}
            onClick={onSave}
          >
            {saving ? 'Saving…' : 'Save dependency'}
          </button>
          <button type="button" className="wr-btn sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}
