// shared/fieldOps/exitGate.ts. WS0. Pure; no imports.

export interface ExitGatePin {
  id: string;
  claimed_by_team: string | null;
  /** Set by the locations route: false when no team assigned in the session may claim the pin. */
  claimable_in_session?: boolean;
}

export interface ExitGateState {
  open: boolean;
  claimed: number;
  total: number;
}

/** True when a team assigned in the session may claim a pin with this claimable_by. */
export function isPinClaimableInSession(
  claimableBy: readonly string[] | null | undefined,
  sessionTeams: readonly string[],
): boolean {
  if (sessionTeams.length === 0) return false;
  if (!claimableBy || claimableBy.length === 0 || claimableBy.includes('all')) return true;
  return claimableBy.some((team) => sessionTeams.includes(team));
}

/** Counts only claimable pins; open when nothing is claimable or everything claimable is claimed. */
export function exitGateState(pins: readonly ExitGatePin[]): ExitGateState {
  const gated = pins.filter((pin) => pin.claimable_in_session !== false);
  const claimed = gated.filter((pin) => Boolean(pin.claimed_by_team)).length;
  return { open: gated.length === 0 || claimed >= gated.length, claimed, total: gated.length };
}

export interface LocationClaim {
  location_id: string;
  claimed_by_team: string | null;
  claimed_as: string | null;
  claim_exclusivity: string | null;
}

type Claimable = {
  id: string;
  claimed_by_team?: string | null;
  claimed_as?: string | null;
  claim_exclusivity?: string | null;
};

/** Writes a claim into the loaded locations, so every later rebuild of the pins keeps it. */
export function applyClaim<T extends Claimable>(rows: readonly T[], claim: LocationClaim): T[] {
  return rows.map((row) =>
    row.id === claim.location_id
      ? {
          ...row,
          claimed_by_team: claim.claimed_by_team,
          claimed_as: claim.claimed_as,
          claim_exclusivity: claim.claim_exclusivity,
        }
      : row,
  );
}
