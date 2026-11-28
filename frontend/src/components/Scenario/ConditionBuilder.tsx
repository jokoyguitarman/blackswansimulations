import { useRef, useState } from 'react';
import type { ConditionDefSpec, ConditionParamSpec } from '@shared/conditionKeyGrammar';
import {
  compileDraft,
  defById,
  defsForPlatform,
  draftFromRaw,
  draftToRaw,
  newConditionRow,
  platformLabel,
  platformsIn,
  retargetRow,
  type ConditionDraft,
  type ConditionNames,
  type ConditionRow,
  type TimedInjectRef,
} from './conditionDraft';

const fieldCls =
  'text-[11px] bg-surface border border-border rounded px-1.5 py-1 text-ink max-w-[16rem]';

export interface InjectChoice {
  id: string;
  title: string;
  injectKey: string | null;
  triggerTime: number | null;
}

export function ConditionBuilder({
  defs,
  draft,
  onChange,
  injects,
  stakeholders,
  teams,
  roles,
  names,
  extraKeys,
  onAssignInjectKey,
  fixedTeamScope,
  appearOnly = false,
  allowEmpty = false,
  emptyLabel,
}: {
  defs: readonly ConditionDefSpec[];
  draft: ConditionDraft;
  onChange: (draft: ConditionDraft) => void;
  injects: readonly InjectChoice[];
  stakeholders: readonly { id: string; name: string }[];
  teams: readonly { name: string; slug: string }[];
  roles: readonly { role_id: string; title: string }[];
  names: ConditionNames;
  extraKeys: readonly string[];
  onAssignInjectKey: (injectId: string) => Promise<string>;
  /** Dependency conditions always scope to this placeholder. The team menu is hidden. */
  fixedTeamScope?: '@upstream' | '@downstream';
  /** Hide cancel conditions and the not-before minute. */
  appearOnly?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const [assigning, setAssigning] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const parseOptions = {
    allowPlaceholders: fixedTeamScope != null,
    allowEmpty,
  };
  const compiled = compileDraft(
    draft,
    defs,
    names,
    extraKeys,
    injects.flatMap((inject) =>
      inject.injectKey
        ? [
            {
              inject_key: inject.injectKey,
              title: inject.title,
              trigger_time_minutes: inject.triggerTime,
            } satisfies TimedInjectRef,
          ]
        : [],
    ),
    parseOptions,
  );
  const scopedRow = (row: ConditionRow): ConditionRow => {
    if (!fixedTeamScope) return row;
    const def = defById(defs, row.event);
    if (!def?.teamScope) return { ...row, team: '', role: '' };
    return { ...row, team: fixedTeamScope, role: '' };
  };
  const platforms = platformsIn(defs);

  const updateRow = (
    list: 'appear' | 'cancel',
    id: string,
    patch: (row: ConditionRow) => ConditionRow,
  ) => {
    onChange({
      ...draft,
      [list]: draft[list].map((row) => (row.id === id ? patch(row) : row)),
    });
  };

  const assignKey = async (
    list: 'appear' | 'cancel',
    row: ConditionRow,
    index: number,
    injectId: string,
  ) => {
    setAssigning(row.id);
    try {
      const key = await onAssignInjectKey(injectId);
      const current = draftRef.current;
      onChange({
        ...current,
        [list]: current[list].map((item) => {
          if (item.id !== row.id) return item;
          const args = [...item.args];
          args[index] = key;
          return { ...item, args };
        }),
      });
    } catch (err) {
      setRawError((err as Error).message);
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div
      className="mt-2 border border-border rounded p-2 bg-surface-2"
      data-section="condition-builder"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted font-medium">When</span>
        <select
          aria-label="How many conditions"
          className={fieldCls}
          value={draft.quantifier}
          onChange={(event) =>
            onChange({
              ...draft,
              quantifier: event.target.value as ConditionDraft['quantifier'],
            })
          }
          disabled={draft.raw}
        >
          <option value="all">all</option>
          <option value="any">any</option>
          <option value="at_least">at least</option>
        </select>
        {draft.quantifier === 'at_least' && (
          <input
            aria-label="Minimum conditions"
            type="number"
            min={2}
            value={draft.threshold}
            onChange={(event) => onChange({ ...draft, threshold: Number(event.target.value) })}
            className={`${fieldCls} w-16`}
            disabled={draft.raw}
          />
        )}
        <span className="text-[11px] text-muted">of these hold</span>
        {!fixedTeamScope && (
          <button
            type="button"
            className="ml-auto text-[11px] text-brand hover:underline"
            onClick={() => {
              setRawError(null);
              if (draft.raw) {
                const next = draftFromRaw(draft, defs);
                if ('error' in next) setRawError(next.error);
                else onChange(next.draft);
              } else {
                onChange(draftToRaw(draft, defs));
              }
            }}
          >
            {draft.raw ? 'Use dropdowns' : 'Raw keys'}
          </button>
        )}
      </div>

      {draft.raw ? (
        <div className="mt-2 space-y-2">
          <label className="text-[11px] text-muted font-medium block">
            Appear JSON
            <textarea
              aria-label="Appear condition JSON"
              value={draft.rawAppear}
              rows={5}
              onChange={(event) => onChange({ ...draft, rawAppear: event.target.value })}
              className="mt-1 w-full text-[11px] font-mono bg-surface border border-border rounded px-2 py-1.5 text-ink"
            />
          </label>
          <label className="text-[11px] text-muted font-medium block">
            Cancel JSON
            <textarea
              aria-label="Cancel condition JSON"
              value={draft.rawCancel}
              rows={3}
              onChange={(event) => onChange({ ...draft, rawCancel: event.target.value })}
              className="mt-1 w-full text-[11px] font-mono bg-surface border border-border rounded px-2 py-1.5 text-ink"
            />
          </label>
        </div>
      ) : (
        <>
          <div className="mt-2 space-y-1.5">
            {draft.appear.map((row) => (
              <ConditionRowEditor
                key={row.id}
                row={row}
                defs={defs}
                platforms={platforms}
                injects={injects}
                stakeholders={stakeholders}
                teams={teams}
                roles={roles}
                assigning={assigning === row.id}
                fixedTeamScope={fixedTeamScope}
                onChange={(patch) =>
                  updateRow('appear', row.id, (current) => scopedRow(patch(current)))
                }
                onRemove={() =>
                  onChange({ ...draft, appear: draft.appear.filter((item) => item.id !== row.id) })
                }
                onAssign={(index, injectId) => assignKey('appear', row, index, injectId)}
              />
            ))}
            <button
              type="button"
              className="text-[11px] text-brand hover:underline"
              onClick={() =>
                onChange({ ...draft, appear: [...draft.appear, scopedRow(newConditionRow(defs))] })
              }
            >
              + Add condition
            </button>
          </div>

          {!appearOnly && (
            <>
              <div className="mt-3 text-[11px] text-muted font-medium">Unless (cancel if any)</div>
              <div className="mt-1 space-y-1.5">
                {draft.cancel.map((row) => (
                  <ConditionRowEditor
                    key={row.id}
                    row={row}
                    defs={defs}
                    platforms={platforms}
                    injects={injects}
                    stakeholders={stakeholders}
                    teams={teams}
                    roles={roles}
                    assigning={assigning === row.id}
                    onChange={(patch) => updateRow('cancel', row.id, patch)}
                    onRemove={() =>
                      onChange({
                        ...draft,
                        cancel: draft.cancel.filter((item) => item.id !== row.id),
                      })
                    }
                    onAssign={(index, injectId) => assignKey('cancel', row, index, injectId)}
                  />
                ))}
                <button
                  type="button"
                  className="text-[11px] text-brand hover:underline"
                  onClick={() =>
                    onChange({ ...draft, cancel: [...draft.cancel, newConditionRow(defs)] })
                  }
                >
                  + Add cancel condition
                </button>
              </div>
            </>
          )}
        </>
      )}

      {!appearOnly && (
        <label className="mt-3 text-[11px] text-muted font-medium flex items-center gap-2">
          Not before T+
          <input
            aria-label="Not before minute"
            type="number"
            min={0}
            value={draft.eligibleAfter}
            placeholder="any time"
            onChange={(event) => onChange({ ...draft, eligibleAfter: event.target.value })}
            className={`${fieldCls} w-20`}
          />
          <span className="font-normal">min</span>
        </label>
      )}

      <p className="mt-2 text-[11px] text-ink" data-section="condition-preview">
        <span className="text-muted font-medium">Preview: </span>
        {allowEmpty && draft.appear.length === 0 && emptyLabel ? emptyLabel : compiled.preview}
      </p>
      {compiled.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-[11px] text-warning" data-section="condition-warning">
          ⚠ {warning}
        </p>
      ))}
      {rawError && <p className="mt-1 text-[11px] text-danger">{rawError}</p>}
      {compiled.errors.map((error) => (
        <p key={error} className="mt-1 text-[11px] text-danger">
          {error}
        </p>
      ))}
    </div>
  );
}

function ConditionRowEditor({
  row,
  defs,
  platforms,
  injects,
  stakeholders,
  teams,
  roles,
  assigning,
  fixedTeamScope,
  onChange,
  onRemove,
  onAssign,
}: {
  row: ConditionRow;
  defs: readonly ConditionDefSpec[];
  platforms: readonly string[];
  injects: readonly InjectChoice[];
  stakeholders: readonly { id: string; name: string }[];
  teams: readonly { name: string; slug: string }[];
  roles: readonly { role_id: string; title: string }[];
  assigning: boolean;
  fixedTeamScope?: '@upstream' | '@downstream';
  onChange: (patch: (row: ConditionRow) => ConditionRow) => void;
  onRemove: () => void;
  onAssign: (index: number, injectId: string) => void;
}) {
  const def = defById(defs, row.event);
  const events = defsForPlatform(defs, row.platform);
  const showRoleScope =
    !fixedTeamScope && Boolean((def?.teamScope && roles.length > 0) || row.role);
  return (
    <div className="flex flex-wrap items-center gap-1.5 bg-surface border border-border rounded p-1.5">
      <select
        aria-label="Condition platform"
        className={fieldCls}
        value={row.platform}
        onChange={(event) => {
          const next = defsForPlatform(defs, event.target.value)[0];
          if (next) onChange(() => retargetRow(row, next));
        }}
      >
        {platforms.map((platform) => (
          <option key={platform} value={platform}>
            {platformLabel(platform)}
          </option>
        ))}
      </select>
      <select
        aria-label="Condition event"
        className={`${fieldCls} max-w-[22rem]`}
        value={row.event}
        onChange={(event) => {
          const next = defById(defs, event.target.value);
          if (next) onChange(() => retargetRow(row, next));
        }}
      >
        {events.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label || item.id}
          </option>
        ))}
        {def && !events.some((item) => item.id === def.id) && (
          <option value={def.id}>{def.label || def.id}</option>
        )}
      </select>
      {(def?.params ?? []).map((param, index) => (
        <ParamControl
          key={`${param.name}-${index}`}
          param={param}
          value={row.args[index] ?? ''}
          injects={injects}
          stakeholders={stakeholders}
          teams={teams}
          roles={roles}
          assigning={assigning}
          onChange={(value) =>
            onChange((current) => {
              const args = [...current.args];
              args[index] = value;
              return { ...current, args };
            })
          }
          onAssign={(injectId) => onAssign(index, injectId)}
        />
      ))}
      {def?.teamScope && fixedTeamScope && (
        <span className="text-[11px] text-muted px-1" data-section="fixed-team-scope">
          {fixedTeamScope === '@upstream' ? 'upstream team' : 'downstream team'}
        </span>
      )}
      {def?.teamScope && !fixedTeamScope && (
        <select
          aria-label="Team scope"
          className={fieldCls}
          value={row.team}
          onChange={(event) =>
            onChange((current) => ({ ...current, team: event.target.value, role: '' }))
          }
        >
          <option value="">team any</option>
          {teams.map((team) => (
            <option key={team.slug} value={team.slug}>
              team {team.name}
            </option>
          ))}
          {row.team && !teams.some((team) => team.slug === row.team) && (
            <option value={row.team}>team {row.team}</option>
          )}
        </select>
      )}
      {showRoleScope && (
        <select
          aria-label="Role scope"
          className={fieldCls}
          value={row.role}
          onChange={(event) =>
            onChange((current) => ({ ...current, role: event.target.value, team: '' }))
          }
        >
          <option value="">role any</option>
          {roles.map((role) => (
            <option key={role.role_id} value={role.role_id}>
              role {role.title}
            </option>
          ))}
          {row.role && !roles.some((role) => role.role_id === row.role) && (
            <option value={row.role}>role {row.role}</option>
          )}
        </select>
      )}
      {def?.deprecated?.use && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/40">
          Deprecated: use {def.deprecated.use}
        </span>
      )}
      <button
        type="button"
        aria-label="Remove condition"
        className="text-muted hover:text-danger text-sm px-1"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

function ParamControl({
  param,
  value,
  injects,
  stakeholders,
  teams,
  roles,
  assigning,
  onChange,
  onAssign,
}: {
  param: ConditionParamSpec;
  value: string;
  injects: readonly InjectChoice[];
  stakeholders: readonly { id: string; name: string }[];
  teams: readonly { name: string; slug: string }[];
  roles: readonly { role_id: string; title: string }[];
  assigning: boolean;
  onChange: (value: string) => void;
  onAssign: (injectId: string) => void;
}) {
  if (param.type === 'inject_key') {
    return (
      <select
        aria-label="Inject"
        className={fieldCls}
        value={value}
        disabled={assigning}
        onChange={(event) => {
          const next = event.target.value;
          if (next.startsWith('assign:')) onAssign(next.slice('assign:'.length));
          else onChange(next);
        }}
      >
        <option value="">{assigning ? 'Assigning key…' : 'Choose inject'}</option>
        {injects.map((inject) =>
          inject.injectKey ? (
            <option key={inject.id} value={inject.injectKey}>
              {inject.title || inject.injectKey}
            </option>
          ) : (
            <option key={inject.id} value={`assign:${inject.id}`}>
              {inject.title || 'Untitled'} (assign key)
            </option>
          ),
        )}
        {value && !injects.some((inject) => inject.injectKey === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    );
  }
  if (param.type === 'minutes' || param.type === 'seconds' || param.type === 'int') {
    const unit = param.type === 'minutes' ? 'min' : param.type === 'seconds' ? 'sec' : '';
    return (
      <label className="flex items-center gap-1 text-[11px] text-muted">
        {param.type === 'int' ? param.name : 'within'}
        <input
          aria-label={param.name}
          type="number"
          min={param.min}
          max={param.max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${fieldCls} w-16`}
        />
        {unit}
      </label>
    );
  }
  if (param.type === 'stakeholder') {
    return (
      <select
        aria-label="Stakeholder"
        className={fieldCls}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose stakeholder</option>
        {stakeholders.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        {value && !stakeholders.some((item) => item.id === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    );
  }
  if (param.type === 'enum' || param.type === 'tone') {
    return (
      <select
        aria-label={param.name}
        className={fieldCls}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {(param.enum ?? []).map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    );
  }
  if (param.name === 'team_slug' || param.type === 'team') {
    return (
      <select
        aria-label="Team"
        className={fieldCls}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose team</option>
        {teams.map((team) => (
          <option key={team.slug} value={team.slug}>
            {team.name}
          </option>
        ))}
        {value && !teams.some((team) => team.slug === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    );
  }
  if (param.name === 'role_id') {
    return (
      <select
        aria-label="Role"
        className={fieldCls}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose role</option>
        {roles.map((role) => (
          <option key={role.role_id} value={role.role_id}>
            {role.title}
          </option>
        ))}
        {value && !roles.some((role) => role.role_id === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    );
  }
  return (
    <input
      aria-label={param.name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={fieldCls}
    />
  );
}
