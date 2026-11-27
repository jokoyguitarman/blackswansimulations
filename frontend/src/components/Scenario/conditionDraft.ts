import {
  applyLabelTokens,
  builderModelToKey,
  keyToBuilderModel,
  type BuilderModel,
  type ConditionDefSpec,
  type ConditionParamSpec,
} from '@shared/conditionKeyGrammar';
import { conditionPreviewSentence, type PreviewQuantifier } from './conditionPreview';

export interface ConditionRow {
  id: string;
  platform: string;
  event: string;
  args: string[];
  team: string;
  role: string;
}

export interface ConditionDraft {
  quantifier: PreviewQuantifier;
  threshold: number;
  appear: ConditionRow[];
  cancel: ConditionRow[];
  eligibleAfter: string;
  raw: boolean;
  rawAppear: string;
  rawCancel: string;
}

export interface ConditionNames {
  injectTitle: (key: string) => string | undefined;
  stakeholderName: (id: string) => string | undefined;
  teamName: (slug: string) => string | undefined;
  roleTitle: (roleId: string) => string | undefined;
}

export interface CompiledConditions {
  conditions_to_appear: { all: string[] } | { threshold: number; conditions: string[] };
  conditions_to_cancel: string[];
  eligible_after_minutes: number | null;
  errors: string[];
  warnings: string[];
  preview: string;
}

export interface TimedInjectRef {
  inject_key: string;
  title: string;
  trigger_time_minutes: number | null;
}

let rowSeq = 0;

export function nextConditionRowId(): string {
  rowSeq += 1;
  return `cond-${rowSeq}`;
}

export function emptyConditionNames(): ConditionNames {
  return {
    injectTitle: () => undefined,
    stakeholderName: () => undefined,
    teamName: () => undefined,
    roleTitle: () => undefined,
  };
}

export function defaultArg(param: ConditionParamSpec): string {
  if (param.type === 'minutes') return String(param.min != null && param.min > 10 ? param.min : 10);
  if (param.type === 'seconds') return String(param.min ?? 5);
  if (param.type === 'int') return String(param.min ?? 1);
  if (param.type === 'enum' || param.type === 'tone') return param.enum?.[0] ?? '';
  return '';
}

export function platformsIn(defs: readonly ConditionDefSpec[]): string[] {
  const order = [
    'email',
    'call',
    'chat',
    'dm',
    'social',
    'news',
    'stakeholder',
    'cross',
    'groups',
    'docs',
    'warroom',
    'session',
  ];
  const present = new Set(defs.map((def) => def.platform));
  const known = order.filter((platform) => present.has(platform));
  for (const platform of present) {
    if (!known.includes(platform)) known.push(platform);
  }
  return known;
}

export function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    social: 'Social',
    email: 'Email',
    chat: 'Chat',
    dm: 'Direct message',
    call: 'Call',
    news: 'News',
    docs: 'Docs',
    groups: 'Groups',
    stakeholder: 'Stakeholder',
    cross: 'Any channel',
    warroom: 'War room',
    session: 'Session',
  };
  return labels[platform] ?? platform;
}

export function defsForPlatform(
  defs: readonly ConditionDefSpec[],
  platform: string,
): ConditionDefSpec[] {
  return defs.filter((def) => def.platform === platform);
}

export function defById(
  defs: readonly ConditionDefSpec[],
  id: string,
): ConditionDefSpec | undefined {
  return defs.find((def) => def.id === id);
}

export function newConditionRow(
  defs: readonly ConditionDefSpec[],
  platform = 'email',
): ConditionRow {
  const group = defsForPlatform(defs, platform);
  const def = group[0] ?? defs[0];
  if (!def) {
    return {
      id: nextConditionRowId(),
      platform,
      event: '',
      args: [],
      team: '',
      role: '',
    };
  }
  return rowForDef(def);
}

function rowForDef(def: ConditionDefSpec): ConditionRow {
  return {
    id: nextConditionRowId(),
    platform: def.platform,
    event: def.id,
    args: def.looseArgs ? [''] : (def.params ?? []).map((param) => defaultArg(param)),
    team: '',
    role: '',
  };
}

export function retargetRow(row: ConditionRow, def: ConditionDefSpec): ConditionRow {
  return {
    ...row,
    platform: def.platform,
    event: def.id,
    args: def.looseArgs ? [''] : (def.params ?? []).map((param) => defaultArg(param)),
    team: def.teamScope ? row.team : '',
    role: def.kind === 'prefix' ? row.role : '',
  };
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
}

function readAppear(value: unknown): {
  quantifier: PreviewQuantifier;
  threshold: number;
  keys: string[];
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { all?: unknown; conditions?: unknown; threshold?: unknown };
  if (Array.isArray(record.all)) {
    return { quantifier: 'all', threshold: 1, keys: stringsOf(record.all) };
  }
  if (Array.isArray(record.conditions)) {
    const threshold = typeof record.threshold === 'number' ? record.threshold : 1;
    if (threshold <= 1) {
      return { quantifier: 'any', threshold: 1, keys: stringsOf(record.conditions) };
    }
    return {
      quantifier: 'at_least',
      threshold: Math.floor(threshold),
      keys: stringsOf(record.conditions),
    };
  }
  return null;
}

function rowFromKey(
  key: string,
  defs: readonly ConditionDefSpec[],
): { row: ConditionRow } | { error: string } {
  const parsed = keyToBuilderModel(key, defs);
  if ('error' in parsed) return parsed;
  const model = parsed.model;
  return {
    row: {
      id: nextConditionRowId(),
      platform: model.platform,
      event: model.event,
      args: model.args,
      team: model.scope?.team ?? '',
      role: model.scope?.role ?? '',
    },
  };
}

export function emptyDraft(): ConditionDraft {
  return {
    quantifier: 'all',
    threshold: 2,
    appear: [],
    cancel: [],
    eligibleAfter: '',
    raw: false,
    rawAppear: '{\n  "all": []\n}',
    rawCancel: '[]',
  };
}

export function draftFromStored(
  appear: unknown,
  cancel: unknown,
  eligible: number | null,
  defs: readonly ConditionDefSpec[],
): ConditionDraft {
  const base = emptyDraft();
  base.eligibleAfter = eligible != null ? String(eligible) : '';
  base.rawAppear = JSON.stringify(appear ?? { all: [] }, null, 2);
  base.rawCancel = JSON.stringify(Array.isArray(cancel) ? cancel : [], null, 2);
  const shape = readAppear(appear);
  if (!shape) {
    base.raw = appear != null;
    return base;
  }
  const appearRows: ConditionRow[] = [];
  for (const key of shape.keys) {
    const row = rowFromKey(key, defs);
    if ('error' in row) {
      base.raw = true;
      return base;
    }
    appearRows.push(row.row);
  }
  const cancelRows: ConditionRow[] = [];
  for (const key of stringsOf(cancel)) {
    const row = rowFromKey(key, defs);
    if ('error' in row) {
      base.raw = true;
      return base;
    }
    cancelRows.push(row.row);
  }
  base.quantifier = shape.quantifier;
  base.threshold = shape.threshold;
  base.appear = appearRows;
  base.cancel = cancelRows;
  return base;
}

export function rowToModel(row: ConditionRow): BuilderModel {
  const scope: BuilderModel['scope'] = {};
  if (row.team) scope.team = row.team;
  else if (row.role) scope.role = row.role;
  return {
    platform: row.platform,
    event: row.event,
    args: row.args,
    ...(scope.team || scope.role ? { scope } : {}),
  };
}

export function rowKey(
  row: ConditionRow,
  defs: readonly ConditionDefSpec[],
): { key: string } | { error: string } {
  if (!row.event) return { error: 'Choose an event' };
  return builderModelToKey(rowToModel(row), defs);
}

function clauseFor(
  row: ConditionRow,
  defs: readonly ConditionDefSpec[],
  names: ConditionNames,
): string {
  const def = defById(defs, row.event);
  if (!def?.label) return row.event;
  const shown = (def.params ?? []).map((param, index) => {
    const raw = row.args[index] ?? '';
    if (param.type === 'inject_key') {
      const title = names.injectTitle(raw);
      return title ? `‘${title}’` : raw ? `‘${raw}’` : '{inject}';
    }
    if (param.type === 'stakeholder') return names.stakeholderName(raw) || raw || '{stakeholder}';
    return raw;
  });
  let text = applyLabelTokens(def.label, def.params ?? [], shown);
  if (row.team) text += ` (team ${names.teamName(row.team) || row.team})`;
  else if (row.role) text += ` (role ${names.roleTitle(row.role) || row.role})`;
  return text;
}

function eligibleNumber(raw: string): { value: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  if (!/^\d+$/.test(trimmed)) return { error: 'Not before must be a whole number of minutes' };
  return { value: Number(trimmed) };
}

function rawDocument(
  draft: ConditionDraft,
  defs: readonly ConditionDefSpec[],
  extraKeys: ReadonlySet<string>,
): { appear: unknown; cancel: unknown; errors: string[] } {
  const errors: string[] = [];
  let appear: unknown = null;
  let cancel: unknown = [];
  try {
    appear = JSON.parse(draft.rawAppear) as unknown;
  } catch {
    errors.push('Appear conditions are not valid JSON');
  }
  try {
    cancel = JSON.parse(draft.rawCancel) as unknown;
  } catch {
    errors.push('Cancel conditions are not valid JSON');
  }
  if (errors.length > 0) return { appear, cancel, errors };
  const shape = readAppear(appear);
  if (!shape) {
    errors.push(
      'Appear conditions must be { "all": [...] } or { "threshold": N, "conditions": [...] }',
    );
    return { appear, cancel, errors };
  }
  if (!Array.isArray(cancel)) {
    errors.push('Cancel conditions must be a JSON list of keys');
    return { appear, cancel, errors };
  }
  const keys = [...shape.keys, ...stringsOf(cancel)];
  for (const key of keys) {
    if (extraKeys.has(key)) continue;
    const parsed = keyToBuilderModel(key, defs);
    if ('error' in parsed) errors.push(`${key}: ${parsed.error}`);
  }
  return { appear, cancel, errors };
}

export function compileDraft(
  draft: ConditionDraft,
  defs: readonly ConditionDefSpec[],
  names: ConditionNames,
  extraKeys: readonly string[] = [],
  injects: readonly TimedInjectRef[] = [],
): CompiledConditions {
  const extra = new Set(extraKeys);
  const errors: string[] = [];
  let appearKeys: string[] = [];
  let cancelKeys: string[] = [];
  let quantifier = draft.quantifier;
  let threshold = draft.quantifier === 'any' ? 1 : draft.threshold;
  const appearClauses: string[] = [];
  const cancelClauses: string[] = [];

  if (draft.raw) {
    const doc = rawDocument(draft, defs, extra);
    errors.push(...doc.errors);
    const shape = errors.length === 0 ? readAppear(doc.appear) : null;
    if (shape) {
      quantifier = shape.quantifier;
      threshold = shape.threshold;
      appearKeys = shape.keys;
      cancelKeys = stringsOf(doc.cancel);
      for (const key of appearKeys) appearClauses.push(clauseForKey(key, defs, names));
      for (const key of cancelKeys) cancelClauses.push(clauseForKey(key, defs, names));
    }
  } else {
    for (const row of draft.appear) {
      const key = rowKey(row, defs);
      if ('error' in key) errors.push(key.error);
      else {
        appearKeys.push(key.key);
        appearClauses.push(clauseFor(row, defs, names));
      }
    }
    for (const row of draft.cancel) {
      const key = rowKey(row, defs);
      if ('error' in key) errors.push(key.error);
      else {
        cancelKeys.push(key.key);
        cancelClauses.push(clauseFor(row, defs, names));
      }
    }
  }

  if (quantifier === 'at_least') {
    if (threshold < 2) errors.push('At least needs a number of 2 or more');
    if (threshold > appearKeys.length) {
      errors.push(`At least ${threshold} needs ${threshold} conditions`);
    }
  }

  if (appearKeys.length === 0) errors.push('A conditional inject needs at least one condition');

  const eligible = eligibleNumber(draft.eligibleAfter);
  if ('error' in eligible) errors.push(eligible.error);

  const conditions_to_appear =
    quantifier === 'all'
      ? { all: appearKeys }
      : { threshold: quantifier === 'any' ? 1 : threshold, conditions: appearKeys };

  const warnings = timingWarnings([...appearKeys, ...cancelKeys], defs, injects);
  const preview = conditionPreviewSentence({
    quantifier,
    threshold,
    appear: appearClauses,
    cancel: cancelClauses,
    notBefore: 'error' in eligible ? null : eligible.value,
  });

  return {
    conditions_to_appear,
    conditions_to_cancel: cancelKeys,
    eligible_after_minutes: 'error' in eligible ? null : eligible.value,
    errors,
    warnings,
    preview,
  };
}

function clauseForKey(
  key: string,
  defs: readonly ConditionDefSpec[],
  names: ConditionNames,
): string {
  const parsed = keyToBuilderModel(key, defs);
  if ('error' in parsed) return key;
  return clauseFor(
    {
      id: key,
      platform: parsed.model.platform,
      event: parsed.model.event,
      args: parsed.model.args,
      team: parsed.model.scope?.team ?? '',
      role: parsed.model.scope?.role ?? '',
    },
    defs,
    names,
  );
}

export function timingWarnings(
  keys: readonly string[],
  defs: readonly ConditionDefSpec[],
  injects: readonly TimedInjectRef[],
): string[] {
  const byKey = new Map(injects.map((inject) => [inject.inject_key, inject]));
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const parsed = keyToBuilderModel(key, defs);
    if ('error' in parsed) continue;
    const def = defById(defs, parsed.model.event);
    (def?.params ?? []).forEach((param, index) => {
      if (param.type !== 'inject_key') return;
      const injectKey = parsed.model.args[index] ?? '';
      if (!injectKey || seen.has(injectKey)) return;
      seen.add(injectKey);
      const inject = byKey.get(injectKey);
      if (!inject) {
        warnings.push(`No inject on this scenario uses the key ‘${injectKey}’.`);
        return;
      }
      if (inject.trigger_time_minutes != null) {
        warnings.push(
          `Inject ‘${inject.title || injectKey}’ is timed at T+${inject.trigger_time_minutes}; this inject can't fire before then.`,
        );
      }
    });
  }
  return warnings;
}

export function draftToRaw(
  draft: ConditionDraft,
  defs: readonly ConditionDefSpec[],
): ConditionDraft {
  const appearKeys = draft.appear.flatMap((row) => {
    const key = rowKey(row, defs);
    return 'error' in key ? [] : [key.key];
  });
  const cancelKeys = draft.cancel.flatMap((row) => {
    const key = rowKey(row, defs);
    return 'error' in key ? [] : [key.key];
  });
  const appear =
    draft.quantifier === 'all'
      ? { all: appearKeys }
      : {
          threshold: draft.quantifier === 'any' ? 1 : draft.threshold,
          conditions: appearKeys,
        };
  return {
    ...draft,
    raw: true,
    rawAppear: JSON.stringify(appear, null, 2),
    rawCancel: JSON.stringify(cancelKeys, null, 2),
  };
}

export function draftFromRaw(
  draft: ConditionDraft,
  defs: readonly ConditionDefSpec[],
): { draft: ConditionDraft } | { error: string } {
  let appear: unknown;
  let cancel: unknown;
  try {
    appear = JSON.parse(draft.rawAppear) as unknown;
  } catch {
    return { error: 'Appear conditions are not valid JSON' };
  }
  try {
    cancel = JSON.parse(draft.rawCancel) as unknown;
  } catch {
    return { error: 'Cancel conditions are not valid JSON' };
  }
  const eligible = eligibleNumber(draft.eligibleAfter);
  const next = draftFromStored(appear, cancel, 'error' in eligible ? null : eligible.value, defs);
  if (next.raw) {
    return { error: 'Some keys cannot be shown as dropdowns. Keep raw keys, or fix them first.' };
  }
  return { draft: { ...next, eligibleAfter: draft.eligibleAfter } };
}
