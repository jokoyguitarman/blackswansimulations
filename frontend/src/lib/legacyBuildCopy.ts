/**
 * Legacy build-error copy (durable builds off). The card always ends with
 * {@link LEGACY_RETRY_SUFFIX}; transport failures choose a body from whether
 * the NDJSON reader saw a line.
 */

export const STAGE_LABEL = {
  characters: 'Characters',
  storyline: 'Storyline',
  convergence: 'Convergence',
  pages: 'Organisation pages',
} as const;

export type LegacyBuildStage = keyof typeof STAGE_LABEL;

/** Replaces "Retry to rebuild the scenario from this stage." */
export const LEGACY_RETRY_SUFFIX = 'Retry starts the build again from Characters.';

const FALLBACK_BODY = 'The generator did not return a result.';

/**
 * Stream cut after at least one NDJSON line. The card appends the retry suffix.
 * Disconnect aborts the stage on the server, so the card does not say the work continues.
 */
export function legacyStreamDroppedBody(stageLabel: string): string {
  return `The connection dropped during the ${stageLabel} stage — the phone may have locked, switched apps or changed network. The server stopped this stage when the connection dropped.`;
}

/** The request failed before any stream line arrived. The card appends the retry suffix. */
export function legacyUnreachableBody(stageLabel: string): string {
  return `Couldn't reach the server to start the ${stageLabel} stage. Check the connection and retry.`;
}

export function legacyTransportBody(stageLabel: string, receivedAnyLine: boolean): string {
  return receivedAnyLine ? legacyStreamDroppedBody(stageLabel) : legacyUnreachableBody(stageLabel);
}

/** Paragraph on the legacy error card. The retry sentence is added once. */
export function legacyErrorCardBody(errorMsg: string | null | undefined): string {
  const lead = errorMsg && errorMsg.trim() ? errorMsg.trim() : FALLBACK_BODY;
  if (lead.endsWith(LEGACY_RETRY_SUFFIX)) return lead;
  return `${lead} ${LEGACY_RETRY_SUFFIX}`;
}
