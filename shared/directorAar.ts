/**
 * After-action shapes for unscripted director events. No database access.
 * The report UI and the server share these rows.
 */

export interface UnscriptedEventRow {
  minute: number;
  target: string;
  cause: string;
  text: string;
  guardrails: string;
  fairness: string;
  decision: string;
  approver: string;
  edits: string;
  outcome: string;
}

export interface FairnessSummaryRow {
  team: string;
  negative_load: number;
  positive_load: number;
  unscripted_events: number;
}

export interface ReplayStatus {
  available: boolean;
  ok: boolean;
  mismatches: number;
  /** The session stored no director proposals, so there is nothing to replay. */
  empty?: boolean;
}

/** A director delivery key (`dir_<n>`). Other inject keys are authored. */
export function isDirectorInjectKey(injectKey: string): boolean {
  return injectKey.startsWith('dir_');
}

export interface UnscriptedAarSection {
  events: UnscriptedEventRow[];
  withheld: UnscriptedEventRow[];
  fairness: FairnessSummaryRow[];
  replay: ReplayStatus;
}
