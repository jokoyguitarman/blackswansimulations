/**
 * Condition-key grammar shared by the server parser and the editor.
 * One scope is allowed, written `|name=value`. Known names are `team` and `role`.
 */

export const KNOWN_CONDITION_SCOPES = ['team', 'role'] as const;

export interface ConditionParamSpec {
  name: string;
  type:
    | 'inject_key'
    | 'minutes'
    | 'seconds'
    | 'team'
    | 'stakeholder'
    | 'tone'
    | 'int'
    | 'enum'
    | 'string';
  enum?: readonly string[];
  min?: number;
  max?: number;
  /** Trailing parameters may be omitted. */
  optional?: boolean;
}

export interface ConditionDefSpec {
  id: string;
  kind: 'fixed' | 'prefix';
  prefix?: string;
  params?: readonly ConditionParamSpec[];
  platform: string;
  /** Set on comms keys that accept `|team=`. Role scope is accepted on every prefix. */
  teamScope?: boolean;
  /** The key is invalid without `|team=` or `|role=`. */
  requiresScope?: boolean;
  /** Legacy prefixes keep the remainder as one argument, including colons. */
  looseArgs?: boolean;
  label?: string;
  deprecated?: { reason: string; use?: string };
}

export interface ConditionScope {
  team?: string;
  role?: string;
  /** `|team=@upstream` or `|team=@downstream`, only inside a team dependency. */
  team_placeholder?: '@upstream' | '@downstream';
  [name: string]: string | undefined;
}

export interface ParseCatalogOptions {
  /** Accept `|team=@upstream` and `|team=@downstream` as `scope.team_placeholder`. */
  allowPlaceholders?: boolean;
}

export type ParsedCatalogCondition<T extends ConditionDefSpec = ConditionDefSpec> =
  { def: T; args: string[]; scope?: ConditionScope } | { error: string };

export interface BuilderModel {
  platform: string;
  event: string;
  args: string[];
  scope?: ConditionScope;
}

const INJECT_KEY_RE = /^[a-z0-9_]{1,60}$/;
const STAKEHOLDER_RE = /^[a-z0-9_]{1,80}$/;

/** Lowercase slug: non-alphanumerics become "_", and leading or trailing "_" is trimmed. */
export function slugifyTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function placeholderTokens(param: { name: string; type: string }): string[] {
  if (param.type === 'inject_key') return ['inject'];
  if (param.type === 'minutes') return ['N'];
  if (param.type === 'seconds') return ['S'];
  if (param.type === 'int') {
    if (param.name === 'N') return ['N'];
    if (param.name === 'n') return ['n'];
    return [param.name];
  }
  if (param.type === 'stakeholder') return ['stakeholder'];
  if (param.name === 'channel') return ['channel'];
  if (param.name === 'verdict') return ['verdict'];
  if (param.name === 'action_type') return ['action'];
  return [param.name];
}

export function applyLabelTokens(
  label: string,
  params: readonly { name: string; type: string }[],
  args: readonly string[],
): string {
  let next = label;
  params.forEach((param, index) => {
    const value = args[index] ?? '';
    for (const token of placeholderTokens(param)) {
      next = next.split(`{${token}}`).join(value);
    }
  });
  return next;
}

function scopeName(scope: ConditionScope): string {
  if (scope.team || scope.team_placeholder) return 'team';
  if (scope.role) return 'role';
  return Object.keys(scope)[0] ?? 'unknown';
}

function parseScope(
  raw: string,
  allowPlaceholders: boolean,
): { scope: ConditionScope } | { error: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0) return { error: 'A condition scope must be written as name=value' };
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return { error: `Invalid condition scope name "${name}"` };
  }
  if (!(KNOWN_CONDITION_SCOPES as readonly string[]).includes(name)) {
    return {
      error: `Unknown condition scope "${name}". Supported scopes: ${KNOWN_CONDITION_SCOPES.join(', ')}`,
    };
  }
  if (!value) return { error: `Condition scope ${name}= is missing its value` };
  const scope: ConditionScope = {};
  if (name === 'team') {
    if (value === '@upstream' || value === '@downstream') {
      if (!allowPlaceholders) {
        return { error: 'Placeholder scopes are only valid inside team dependencies' };
      }
      scope.team_placeholder = value;
      return { scope };
    }
    const slug = slugifyTeamName(value);
    if (!slug) return { error: 'Condition scope team= is missing its value' };
    scope.team = slug;
  } else if (name === 'role') {
    if (!/^[a-z0-9_]{2,40}$/.test(value)) {
      return { error: `Condition scope role=${value} is not a role id` };
    }
    scope.role = value;
  } else {
    scope[name] = value;
  }
  return { scope };
}

function validateTypedArg(param: ConditionParamSpec, raw: string): string | null {
  if (param.type === 'inject_key') {
    return INJECT_KEY_RE.test(raw) ? null : `Inject key "${raw}" must match ^[a-z0-9_]{1,60}$`;
  }
  if (param.type === 'stakeholder') {
    return STAKEHOLDER_RE.test(raw) ? null : `Stakeholder id "${raw}" must be a lowercase slug`;
  }
  if (param.type === 'minutes' || param.type === 'seconds' || param.type === 'int') {
    if (!/^\d+$/.test(raw)) return `${param.name} must be a whole number`;
    const n = Number(raw);
    const min = param.min ?? 0;
    const max = param.max ?? Number.MAX_SAFE_INTEGER;
    if (n < min || n > max) return `${param.name} must be from ${min} to ${max}`;
    return null;
  }
  if (param.type === 'enum' || param.type === 'tone') {
    const allowed = param.enum ?? [];
    return allowed.includes(raw) ? null : `${param.name} must be one of: ${allowed.join(', ')}`;
  }
  return raw.trim() === '' ? 'Argument is empty' : null;
}

function argCountError(params: readonly ConditionParamSpec[], count: number): string | null {
  if (count > params.length) return `Expected ${params.length} argument(s)`;
  if (count < params.length && params.slice(count).some((param) => !param.optional)) {
    return `Expected ${params.length} argument(s)`;
  }
  return null;
}

function splitTypedArgs(
  rest: string,
  params: readonly ConditionParamSpec[],
): { args: string[] } | { error: string } {
  const args = rest.split(':');
  const countError = argCountError(params, args.length);
  if (countError) return { error: countError };
  for (let i = 0; i < args.length; i++) {
    const problem = validateTypedArg(params[i], args[i] ?? '');
    if (problem) return { error: problem };
  }
  return { args };
}

function scopedPrefix<T extends ConditionDefSpec>(
  def: T,
  args: string[],
  scope?: ConditionScope,
): ParsedCatalogCondition<T> {
  if (def.requiresScope && !scope?.team && !scope?.role && !scope?.team_placeholder) {
    return { error: `MO-COND-010: ${def.id} requires a team or role scope` };
  }
  return { def, args, ...(scope ? { scope } : {}) };
}

export function parseCatalogCondition<T extends ConditionDefSpec>(
  key: string,
  catalog: readonly T[],
  options?: ParseCatalogOptions,
): ParsedCatalogCondition<T> {
  const trimmed = key.trim();
  if (!trimmed) return { error: 'Condition key is empty' };

  const pipe = trimmed.indexOf('|');
  let body = trimmed;
  let scope: ConditionScope | undefined;
  if (pipe >= 0) {
    if (trimmed.indexOf('|', pipe + 1) >= 0) {
      return { error: 'A condition key takes at most one scope' };
    }
    body = trimmed.slice(0, pipe);
    if (!body) return { error: 'Condition key is empty' };
    const parsedScope = parseScope(trimmed.slice(pipe + 1), options?.allowPlaceholders === true);
    if ('error' in parsedScope) return parsedScope;
    scope = parsedScope.scope;
  }

  const fixed = catalog.find((def) => def.kind === 'fixed' && def.id === body);
  if (fixed) {
    if (scope) {
      return { error: `Condition key ${fixed.id} does not accept a ${scopeName(scope)} scope` };
    }
    return { def: fixed, args: [] };
  }

  const match = catalog
    .filter((def): def is T & { prefix: string } => def.kind === 'prefix' && !!def.prefix)
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((def) => body.startsWith(def.prefix));
  if (!match) return { error: `Unknown condition key: ${body}` };
  const rest = body.slice(match.prefix.length);
  if (rest.trim() === '') return { error: `Condition key ${body} is missing its argument` };

  if ((scope?.team || scope?.team_placeholder) && !match.teamScope) {
    return { error: `Condition key ${match.id} does not accept a team scope` };
  }

  if (match.looseArgs) return scopedPrefix(match, [rest], scope);

  const split = splitTypedArgs(rest, match.params ?? []);
  if ('error' in split) return { error: split.error };
  return scopedPrefix(match, split.args, scope);
}

function formatScope(scope: ConditionScope | undefined): { suffix: string } | { error: string } {
  if (!scope) return { suffix: '' };
  const names = Object.keys(scope).filter((name) => scope[name]);
  if (names.length > 1) return { error: 'A condition key takes at most one scope' };
  if (scope.team) {
    const slug = slugifyTeamName(scope.team);
    if (!slug) return { error: 'Condition scope team= is missing its value' };
    return { suffix: `|team=${slug}` };
  }
  if (scope.team_placeholder) {
    return { suffix: `|team=${scope.team_placeholder}` };
  }
  if (scope.role) {
    if (!/^[a-z0-9_]{2,40}$/.test(scope.role)) {
      return { error: `Condition scope role=${scope.role} is not a role id` };
    }
    return { suffix: `|role=${scope.role}` };
  }
  if (names.length === 1) {
    const name = names[0];
    return { suffix: `|${name}=${scope[name]}` };
  }
  return { suffix: '' };
}

export function formatConditionKey(
  def: ConditionDefSpec,
  args: readonly string[],
  scope?: ConditionScope,
): { key: string } | { error: string } {
  const formattedScope = formatScope(scope);
  if ('error' in formattedScope) return formattedScope;
  if (def.kind === 'fixed') {
    if (args.length > 0) return { error: `Condition key ${def.id} does not take arguments` };
    if (formattedScope.suffix) {
      return {
        error: `Condition key ${def.id} does not accept a ${scope ? scopeName(scope) : 'unknown'} scope`,
      };
    }
    return { key: def.id };
  }
  if ((scope?.team || scope?.team_placeholder) && !def.teamScope) {
    return { error: `Condition key ${def.id} does not accept a team scope` };
  }
  if (def.requiresScope && !scope?.team && !scope?.role && !scope?.team_placeholder) {
    return { error: `MO-COND-010: ${def.id} requires a team or role scope` };
  }
  if (def.looseArgs) {
    const rest = args[0] ?? '';
    if (args.length !== 1 || rest.trim() === '') {
      return { error: `Condition key ${def.id} is missing its argument` };
    }
    return { key: `${def.prefix ?? `${def.id}:`}${rest}${formattedScope.suffix}` };
  }
  const params = def.params ?? [];
  const countError = argCountError(params, args.length);
  if (countError) return { error: countError };
  for (let i = 0; i < args.length; i++) {
    const problem = validateTypedArg(params[i], args[i] ?? '');
    if (problem) return { error: problem };
  }
  return { key: `${def.prefix ?? `${def.id}:`}${args.join(':')}${formattedScope.suffix}` };
}

export function builderModelToKey(
  model: BuilderModel,
  catalog: readonly ConditionDefSpec[],
): { key: string } | { error: string } {
  const def = catalog.find((item) => item.id === model.event);
  if (!def) return { error: `Unknown condition key: ${model.event}` };
  return formatConditionKey(def, model.args, model.scope);
}

export function keyToBuilderModel(
  key: string,
  catalog: readonly ConditionDefSpec[],
): { model: BuilderModel } | { error: string } {
  const parsed = parseCatalogCondition(key, catalog);
  if ('error' in parsed) return parsed;
  const model: BuilderModel = {
    platform: parsed.def.platform,
    event: parsed.def.id,
    args: parsed.args,
  };
  if (parsed.scope && Object.keys(parsed.scope).length > 0) model.scope = parsed.scope;
  return { model };
}

function sampleArg(param: ConditionParamSpec): string {
  if (param.type === 'inject_key') return 'supplier_4471';
  if (param.type === 'minutes') return String(clampSample(10, param.min ?? 1, param.max ?? 240));
  if (param.type === 'seconds') return String(clampSample(30, param.min ?? 5, param.max ?? 600));
  if (param.type === 'int') return String(clampSample(2, param.min ?? 1, param.max ?? 10000));
  if (param.type === 'stakeholder') return 'stk_a';
  if (param.type === 'enum' || param.type === 'tone') return param.enum?.[0] ?? 'professional';
  if (param.type === 'team' || param.name === 'team_slug') return 'legal';
  if (param.name === 'role_id') return 'cs_head';
  return 'sample_key';
}

function clampSample(prefer: number, min: number, max: number): number {
  if (prefer < min) return min;
  if (prefer > max) return max;
  return prefer;
}

/** One valid builder model per catalogue def, including a scope when the def accepts one. */
export function sampleBuilderModel(
  def: ConditionDefSpec,
  scope: 'none' | 'team' | 'role' = 'none',
): BuilderModel {
  const model: BuilderModel = {
    platform: def.platform,
    event: def.id,
    args:
      def.kind === 'prefix'
        ? def.looseArgs
          ? ['sample_key']
          : (def.params ?? []).map((param) => sampleArg(param))
        : [],
  };
  if (scope === 'team' && def.teamScope) model.scope = { team: 'legal' };
  if (scope === 'role' && def.kind === 'prefix') model.scope = { role: 'cs_head' };
  return model;
}
