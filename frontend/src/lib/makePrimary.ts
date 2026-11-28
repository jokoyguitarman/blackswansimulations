export interface SwappableTeam {
  team_name: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
  team_uid?: string;
  function_key?: string;
  display_name?: string;
}

export interface SwappableOrg {
  id: string;
  display_name: string;
  short_name: string;
  country: string;
  city: string;
  kind: string;
  facebook_handle: string;
  x_handle: string;
  team_roster: SwappableTeam[];
  operation?: 'players' | 'ai';
  org_key?: string;
  org_uid?: string;
}

export interface SwappablePrimary {
  org_key: string;
  org_uid: string;
  display_name: string;
  short_name: string;
  country: string;
  city: string;
  kind: string;
  facebook_handle: string;
  x_handle: string;
  team_roster: SwappableTeam[];
}

/**
 * Move a players-operated organisation into the primary slot and park the
 * previous primary as an extra. `previousFrom` builds that extra in the
 * caller's card type, so the result needs no cast.
 */
export function swapMakePrimary<T extends SwappableOrg>(
  primary: SwappablePrimary,
  extras: readonly T[],
  extraId: string,
  baselinePrimaryKey: string,
  previousFrom: (slot: SwappablePrimary) => T,
): { primary: SwappablePrimary; extras: T[]; makePrimaryKey: string | null } | null {
  const index = extras.findIndex((org) => org.id === extraId);
  if (index < 0) return null;
  const extra = extras[index];
  if (extra.operation === 'ai') return null;
  if (!extra.org_key) return null;
  const nextPrimary: SwappablePrimary = {
    org_key: extra.org_key,
    org_uid: extra.org_uid || '',
    display_name: extra.display_name,
    short_name: extra.short_name,
    country: extra.country,
    city: extra.city,
    kind: extra.kind,
    facebook_handle: extra.facebook_handle,
    x_handle: extra.x_handle,
    team_roster: extra.team_roster.map((team) => ({ ...team })),
  };
  const nextExtras = extras.map((org) => ({ ...org, team_roster: org.team_roster.map((team) => ({ ...team })) }));
  nextExtras.splice(index, 1, previousFrom(primary));
  return {
    primary: nextPrimary,
    extras: nextExtras,
    makePrimaryKey: nextPrimary.org_key === baselinePrimaryKey ? null : nextPrimary.org_key,
  };
}
