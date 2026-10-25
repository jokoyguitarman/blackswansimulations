import { normaliseOrgName, sameOrganisationName } from '@shared/orgNames';

/**
 * Pure helpers for the footprint proposals on the corporate-crisis Setup page.
 * No React, so `node --import tsx --test` can run them directly.
 */

export type ProposalSide = 'office' | 'pressure';

export interface DismissedProposal {
  side: ProposalSide;
  name: string;
}

export const MAX_DISMISSED = 50;

export interface SetupLists {
  primary: { display_name: string; country: string };
  offices: Array<{ display_name: string; country: string; proposed_from?: string }>;
  pressure: Array<{ display_name: string; country: string; proposed_from?: string }>;
}

type NamedCard = { display_name: string; country: string; proposed_from?: string };

/** The names a card answers to: its current name and the proposal it was created from. */
export function namesOf(d: { display_name: string; proposed_from?: string }): string[] {
  const names = [d.display_name, d.proposed_from ?? ''].map((n) => n.trim()).filter(Boolean);
  return names.filter((n, i) => names.findIndex((m) => m === n) === i);
}

function countriesCompatible(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  return !x || !y || x === y;
}

/** True when the proposal is already on its side of the map. The office side includes the primary. */
export function isOnMap(
  side: ProposalSide,
  proposal: { display_name: string; country: string },
  lists: SetupLists,
): boolean {
  const cards: NamedCard[] =
    side === 'office'
      ? [
          { display_name: lists.primary.display_name, country: lists.primary.country },
          ...lists.offices,
        ]
      : lists.pressure;
  return cards.some((card) => {
    if (card.proposed_from && sameOrganisationName(card.proposed_from, proposal.display_name)) {
      return true;
    }
    return (
      sameOrganisationName(card.display_name, proposal.display_name) &&
      countriesCompatible(card.country, proposal.country)
    );
  });
}

/** True when any dismissal on that side names the same organisation. Country is ignored. */
export function isDismissed(list: DismissedProposal[], side: ProposalSide, name: string): boolean {
  return list.some((d) => d.side === side && sameOrganisationName(d.name, name));
}

/** Records the card's current name and its original proposal name. Keeps the newest entries. */
export function recordDismissal(
  list: DismissedProposal[],
  side: ProposalSide,
  draft: { display_name: string; proposed_from?: string },
): DismissedProposal[] {
  const next = [...list];
  for (const name of namesOf(draft)) {
    if (next.some((d) => d.side === side && sameOrganisationName(d.name, name))) continue;
    next.push({ side, name });
  }
  return next.slice(-MAX_DISMISSED);
}

/** Drops every entry on that side naming the same organisation. */
export function clearDismissal(
  list: DismissedProposal[],
  side: ProposalSide,
  name: string,
): DismissedProposal[] {
  return list.filter((d) => d.side !== side || !sameOrganisationName(d.name, name));
}

/** Draft resume: well-formed entries only, trimmed, capped. Anything else is an empty list. */
export function parseDismissedProposals(raw: unknown): DismissedProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: DismissedProposal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const side = (item as { side?: unknown }).side;
    const name = (item as { name?: unknown }).name;
    if ((side !== 'office' && side !== 'pressure') || typeof name !== 'string' || !name.trim()) {
      continue;
    }
    out.push({ side, name: name.trim() });
  }
  return out.slice(-MAX_DISMISSED);
}

function exactName(a: string, b: string): boolean {
  const x = normaliseOrgName(a);
  const y = normaliseOrgName(b);
  return x.length > 0 && x === y;
}

/**
 * Proposals the footprint may add. Skips anything already on the map, previously removed,
 * clashing exactly with the other side, duplicated in this run, or over the room left.
 */
export function selectFootprintAdditions<
  O extends { display_name: string; country: string },
  P extends { display_name: string; country: string },
>(
  footprint: { implied_organisations: O[]; pressure_organisations: P[] },
  lists: SetupLists,
  dismissed: DismissedProposal[],
  room: { offices: number; pressure: number },
): { offices: O[]; pressure: P[]; keptOff: string[]; noRoom: string[] } {
  const keptOff: string[] = [];
  const noRoom: string[] = [];

  const pick = <T extends { display_name: string; country: string }>(
    side: ProposalSide,
    proposals: T[],
    limit: number,
    otherSideNames: string[],
  ): T[] => {
    const picked: T[] = [];
    for (const proposal of proposals) {
      if (isOnMap(side, proposal, lists)) continue;
      if (isDismissed(dismissed, side, proposal.display_name)) {
        keptOff.push(proposal.display_name);
        continue;
      }
      if (otherSideNames.some((n) => exactName(n, proposal.display_name))) continue;
      if (picked.some((p) => sameOrganisationName(p.display_name, proposal.display_name))) continue;
      if (picked.length >= limit) {
        noRoom.push(proposal.display_name);
        continue;
      }
      picked.push(proposal);
    }
    return picked;
  };

  return {
    offices: pick(
      'office',
      footprint.implied_organisations,
      room.offices,
      lists.pressure.map((p) => p.display_name),
    ),
    pressure: pick('pressure', footprint.pressure_organisations, room.pressure, [
      lists.primary.display_name,
      ...lists.offices.map((o) => o.display_name),
    ]),
    keptOff,
    noRoom,
  };
}

/**
 * Copies spokesperson links onto the cards the wizard currently holds.
 * Never adds, drops or reorders cards.
 */
export function mergeSpokespersonLinks<
  T extends { display_name: string; org_key?: string; spokesperson_stakeholder_id?: string },
>(
  drafts: T[],
  wire: Array<{ display_name: string; org_key: string; spokesperson_stakeholder_id?: string }>,
): T[] {
  return drafts.map((draft) => {
    const match = wire.find(
      (w) => w.display_name.trim().toLowerCase() === draft.display_name.trim().toLowerCase(),
    );
    return match
      ? {
          ...draft,
          org_key: match.org_key,
          spokesperson_stakeholder_id: match.spokesperson_stakeholder_id,
        }
      : draft;
  });
}
