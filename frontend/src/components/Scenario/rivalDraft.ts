export interface CompetitorDraft {
  id: string;
  name: string;
  country: string;
  facebook_handle?: string;
  x_handle?: string;
  description: string;
  org_key?: string;
  org_uid?: string;
}

/** A rival card as it may appear in a saved draft, including drafts from before descriptions. */
export interface RivalDraftInput {
  id?: unknown;
  name?: unknown;
  country?: unknown;
  facebook_handle?: unknown;
  x_handle?: unknown;
  description?: unknown;
  org_key?: unknown;
  org_uid?: unknown;
}

function newRivalId(): string {
  return `riv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function newRivalDraft(country: string): CompetitorDraft {
  return {
    id: newRivalId(),
    name: '',
    country,
    facebook_handle: '',
    x_handle: '',
    description: '',
  };
}

/** Old drafts have no id and no description. Assign both; keep anything already stored. */
export function resumeRivalDraft(raw: RivalDraftInput, fallbackCountry: string): CompetitorDraft {
  const id = asString(raw.id)?.trim();
  const country = asString(raw.country)?.trim();
  return {
    id: id || newRivalId(),
    name: asString(raw.name) ?? '',
    country: country || fallbackCountry,
    facebook_handle: asString(raw.facebook_handle),
    x_handle: asString(raw.x_handle),
    description: asString(raw.description) ?? '',
    ...(asString(raw.org_key) ? { org_key: asString(raw.org_key) } : {}),
    ...(asString(raw.org_uid) ? { org_uid: asString(raw.org_uid) } : {}),
  };
}
