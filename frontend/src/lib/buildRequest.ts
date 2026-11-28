import { canonicalJson } from '@shared/canonicalJson';

/**
 * The frozen body sent to `POST /builds`. Defaults match the server schema so
 * `hashBuildRequest` equals the hash the server stores.
 */
export interface BuildRequestDraft {
  crisis_type: string;
  context?: string;
  country?: string;
  org_name?: string;
  brand_logo_url?: string;
  blueprint?: unknown;
  organisations: unknown[];
  competitors?: unknown[];
  pressure_organisations?: unknown[];
  auto_antagonist?: boolean;
  duration?: number;
  mode?: 'create' | 'setup_edit';
  setup_edit_id?: string;
}

export function makeBuildRequest(input: BuildRequestDraft): Record<string, unknown> {
  const request: Record<string, unknown> = {
    crisis_type: input.crisis_type,
    context: input.context ?? '',
    country: input.country ?? 'Singapore',
    organisations: input.organisations,
    competitors: input.competitors ?? [],
    pressure_organisations: input.pressure_organisations ?? [],
    auto_antagonist: input.auto_antagonist ?? true,
    duration: input.duration ?? 60,
  };
  if (input.org_name) request.org_name = input.org_name;
  if (input.brand_logo_url) request.brand_logo_url = input.brand_logo_url;
  if (input.blueprint != null) request.blueprint = input.blueprint;
  if (input.mode) request.mode = input.mode;
  if (input.setup_edit_id) request.setup_edit_id = input.setup_edit_id;
  return request;
}

/** SHA-256 hex of the canonical JSON. Same bytes as the server's `canonicalHash`. */
export async function hashBuildRequest(request: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
