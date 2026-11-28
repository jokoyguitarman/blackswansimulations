import { useRef, useState } from 'react';
import { isInjectKey, uniqueInjectKey } from '@shared/injectKeySlug';
import {
  conditionGroupKeys,
  consequenceInjectDraft,
  dependencyIdInKey,
  displayRef,
  editorCrossTeamProfile,
  quickDependencyEdge,
  readDependencyCause,
  takenDependencyIds,
  uniqueDependencyId,
  type TeamDependencyEdge,
  type TeamRef,
} from '@shared/teamDependencies';
import { api } from '../../lib/api';
import { causeChipText, dependencyPreviewSentence } from './dependencyPreview';
import { formatSaveError, type DependencyDocument } from './dependencyDocument';
import { readScenarioInject, type ScenarioInjectRow } from './scenarioInject';

const inputCls =
  'w-full text-xs bg-surface border border-border rounded px-2 py-1.5 text-ink disabled:opacity-60';

interface InjectRef {
  id: string;
  title: string;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: unknown;
  delivery_config?: Record<string, unknown> | null;
}

export function DependencyCauseRow({
  appearKeys,
  targetTeams,
  deliveryConfig,
  document,
}: {
  appearKeys: readonly string[];
  targetTeams: readonly string[];
  deliveryConfig: Record<string, unknown> | null;
  document: DependencyDocument;
}) {
  const causedId =
    readDependencyCause(deliveryConfig) ??
    appearKeys.map(dependencyIdInKey).find((id): id is string => !!id) ??
    null;
  const edge = causedId ? document.edges.find((item) => item.id === causedId) : undefined;
  const profile = editorCrossTeamProfile({
    appearKeys,
    targetTeams,
    edges: document.edges,
    teams: document.teams,
  });
  if (!edge && !profile.is_cross_team) return null;
  const upstream = edge ? displayRef(edge.upstream, document.teams) : null;
  const lands = edge
    ? targetTeams.length > 0
      ? targetTeams
      : edge.downstream.map((ref) => displayRef(ref, document.teams).name)
    : profile.target_teams;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-section="dependency-cause">
      {profile.is_cross_team && (
        <span
          className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-brand/40 text-brand"
          data-section="cross-team-badge"
        >
          Cross-team
        </span>
      )}
      {edge && upstream && (
        <span className="text-[11px] text-ink bg-surface-2 border border-border rounded px-2 py-1">
          {causeChipText(upstream.name, edge.deliverable, lands)}
        </span>
      )}
    </div>
  );
}

export function DependencyQuickAction({
  scenarioId,
  injectId,
  injectTitle,
  injectKey,
  requiresResponse,
  targetTeams,
  deliveryConfig,
  injects,
  document,
  onInjectCreated,
  onInjectKey,
}: {
  scenarioId: string;
  injectId: string | null;
  injectTitle: string;
  injectKey: string;
  requiresResponse: boolean;
  targetTeams: readonly string[];
  deliveryConfig: Record<string, unknown>;
  injects: readonly InjectRef[];
  document: DependencyDocument;
  onInjectCreated: (row: ScenarioInjectRow) => void;
  onInjectKey: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [lag, setLag] = useState(5);
  const [downstreamValue, setDownstreamValue] = useState('');
  const [upstreamValue, setUpstreamValue] = useState('');
  const [consequenceTitle, setConsequenceTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const savedConsequence = useRef<{
    edge: TeamDependencyEdge;
    injectKey: string;
    title: string;
    content: string;
    team: string;
  } | null>(null);

  if (!requiresResponse) return null;
  const playable = document.teams.filter((team) => team.playable !== false);
  const namedTarget = targetTeams.length === 1 ? targetTeams[0] : null;
  const buttonLabel = namedTarget
    ? `If ${namedTarget} fails this, affect another team…`
    : 'If this team fails this, affect another team…';

  const upstream = resolveChoice(namedTarget ?? upstreamValue, playable);
  const downstream = resolveChoice(downstreamValue, playable);
  const title =
    consequenceTitle.trim() || (downstream ? `Consequence for ${downstream.team_name}` : '');
  const preview =
    upstream && downstream && title
      ? dependencyPreviewSentence({
          upstream: upstream.team_name,
          downstream: [downstream.team_name],
          brokenKeys: [
            `unresponded:${injectKey || 'this_inject'}:${Math.max(0, minutes)}|team=@upstream`,
          ],
          metKeys: [`responded_relevant:${injectKey || 'this_inject'}|team=@upstream`],
          lagMinutes: lag,
          consequences: [{ team: downstream.team_name, title }],
          injectTitles: { [injectKey || 'this_inject']: injectTitle || 'this inject' },
        })
      : '';

  const create = async () => {
    if (!injectId) return;
    if (document.error) {
      setMessage(
        `These dependencies could not be read, so a new one was not added. ${document.error}`,
      );
      return;
    }
    if (!upstream || !downstream) {
      setMessage('Choose the team that fails this and the team that feels it.');
      return;
    }
    if (sameTeamRef(upstream, downstream)) {
      setMessage('The other team has to be different from the team that fails this.');
      return;
    }
    if (
      !Number.isInteger(minutes) ||
      minutes < 0 ||
      !Number.isInteger(lag) ||
      lag < 0 ||
      lag > 30
    ) {
      setMessage('Minutes must be a whole number, and the lag at most 30.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      let key = injectKey;
      if (!isInjectKey(key)) {
        const taken = takenKeys(injects);
        key = uniqueInjectKey(injectTitle || 'inject', taken);
        await api.scenarios.updateInject(scenarioId, injectId, {
          delivery_config: { ...deliveryConfig, inject_key: key },
        });
        onInjectKey(key);
      }
      let pending = savedConsequence.current;
      if (!pending) {
        const depId = uniqueDependencyId(
          injectTitle || downstream.team_name,
          takenDependencyIds(document.edges, injects),
        );
        const consKey = uniqueInjectKey(title, takenKeys(injects, key));
        const edge = quickDependencyEdge({
          id: depId,
          injectKey: key,
          injectTitle: injectTitle.trim() || 'this inject',
          upstream,
          downstream,
          withinMinutes: minutes,
          lagMinutes: lag,
          consequenceKey: consKey,
        });
        const content = dependencyPreviewSentence({
          upstream: upstream.team_name,
          downstream: [downstream.team_name],
          brokenKeys: conditionGroupKeys(edge.broken_when),
          metKeys: conditionGroupKeys(edge.met_when),
          lagMinutes: edge.lag_minutes,
          consequences: [{ team: downstream.team_name, title }],
          injectTitles: { [key]: injectTitle || key },
        });
        await document.commit((current) =>
          current.some((item) => item.id === edge.id) ? [...current] : [...current, edge],
        );
        pending = {
          edge,
          injectKey: consKey,
          title,
          content,
          team: downstream.team_name,
        };
        savedConsequence.current = pending;
      }
      try {
        const created = await api.scenarios.createInject(
          scenarioId,
          consequenceInjectDraft({
            edge: pending.edge,
            team: pending.team,
            injectKey: pending.injectKey,
            title: pending.title,
            content: pending.content,
          }),
        );
        const row = readScenarioInject(created.data);
        if (!row) throw new Error('The consequence inject came back without an id.');
        savedConsequence.current = null;
        onInjectCreated(row);
      } catch (err) {
        setMessage(
          `The dependency was saved, but the consequence inject was not. ${formatSaveError(err)}`,
        );
        setSaving(false);
        return;
      }
      setOpen(false);
      setMessage(null);
    } catch (err) {
      setMessage(formatSaveError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2" data-section="dependency-quick-action">
      <button
        type="button"
        className="text-xs text-brand hover:underline disabled:opacity-40"
        disabled={!injectId || saving}
        title={injectId ? undefined : 'Save this inject first'}
        onClick={() => setOpen((current) => !current)}
      >
        {buttonLabel}
      </button>
      {open && (
        <div
          className="mt-2 border border-border rounded p-2 bg-surface-2 space-y-2"
          role="dialog"
          aria-label="Affect another team"
        >
          {!namedTarget && (
            <label className="text-[11px] text-muted font-medium block">
              Team that fails this
              <select
                aria-label="Team that fails this"
                className={`${inputCls} mt-0.5`}
                value={upstreamValue}
                onChange={(event) => setUpstreamValue(event.target.value)}
              >
                <option value="">Choose team</option>
                {playable.map((team) => (
                  <option key={team.team_name} value={team.team_name}>
                    {team.team_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-[11px] text-muted font-medium block">
            Team that feels it
            <select
              aria-label="Affected team"
              className={`${inputCls} mt-0.5`}
              value={downstreamValue}
              onChange={(event) => setDownstreamValue(event.target.value)}
            >
              <option value="">Choose team</option>
              {playable.map((team) => (
                <option key={team.team_name} value={team.team_name}>
                  {team.team_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-muted font-medium block">
            Consequence title
            <input
              aria-label="Consequence title"
              className={`${inputCls} mt-0.5`}
              value={consequenceTitle}
              placeholder={
                downstream ? `Consequence for ${downstream.team_name}` : 'What they receive'
              }
              onChange={(event) => setConsequenceTitle(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <label className="text-[11px] text-muted font-medium">
              No reply within
              <input
                aria-label="Minutes without a reply"
                type="number"
                min={0}
                className={`${inputCls} mt-0.5 w-20`}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            <label className="text-[11px] text-muted font-medium">
              Then lag
              <input
                aria-label="Lag minutes"
                type="number"
                min={0}
                max={30}
                className={`${inputCls} mt-0.5 w-20`}
                value={lag}
                onChange={(event) => setLag(Number(event.target.value))}
              />
            </label>
          </div>
          {preview && <p className="text-[11px] text-ink">{preview}</p>}
          {message && <p className="text-[11px] text-danger">{message}</p>}
          <button
            type="button"
            className="wr-btn sm accent"
            disabled={saving || !injectId}
            onClick={() => void create()}
          >
            {saving ? 'Saving…' : 'Create dependency and consequence'}
          </button>
        </div>
      )}
    </div>
  );
}

function resolveChoice(
  name: string,
  teams: readonly { team_name: string; team_uid?: string | null; playable?: boolean }[],
): TeamRef | null {
  if (!name) return null;
  const team = teams.find((item) => item.team_name === name);
  if (!team || team.playable === false) return null;
  return { team_uid: team.team_uid ?? null, team_name: team.team_name };
}

function sameTeamRef(left: TeamRef, right: TeamRef): boolean {
  if (left.team_uid && right.team_uid) return left.team_uid === right.team_uid;
  return left.team_name === right.team_name;
}

function takenKeys(injects: readonly InjectRef[], extra?: string): Set<string> {
  const taken = new Set<string>();
  for (const inject of injects) {
    const key = inject.delivery_config?.inject_key;
    if (typeof key === 'string' && isInjectKey(key)) taken.add(key);
  }
  if (extra && isInjectKey(extra)) taken.add(extra);
  return taken;
}
