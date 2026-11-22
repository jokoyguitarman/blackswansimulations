/**
 * Round-trip for `rts_scene_configs.blast_site`.
 * SceneEditor stores radius, weaponType, gameZones and locationDescription on the
 * same JSON object. Load keeps that object; save writes the charge fields on top.
 */

export interface StoredCharge {
  presetKey?: unknown;
  amountKg?: unknown;
  burst?: unknown;
  heightM?: unknown;
}

export interface BlastSiteRead {
  pos: { x: number; y: number };
  record: Record<string, unknown>;
  charge: StoredCharge | null;
  /** True for a saved manual override, and for an old scene that has no charge. */
  manualRadius: boolean;
  /** `manualRadiusM` when present, otherwise the legacy `radius`. */
  radiusM: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readStoredBlast(raw: unknown): BlastSiteRead | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = { ...(raw as Record<string, unknown>) };
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (x == null || y == null) return null;
  const chargeRaw = record.charge;
  const charge =
    chargeRaw && typeof chargeRaw === 'object' ? (chargeRaw as StoredCharge) : null;
  const manualFlag = record.manualRadius;
  const manualRadius = typeof manualFlag === 'boolean' ? manualFlag : charge == null;
  const radiusM = finiteNumber(record.manualRadiusM) ?? finiteNumber(record.radius);
  return { pos: { x, y }, record, charge, manualRadius, radiusM };
}

export function writeStoredBlast(
  record: Record<string, unknown> | null,
  pos: { x: number; y: number },
  charge: unknown,
  manualRadius: boolean,
  blastRadius: number,
): { x: number; y: number } & Record<string, unknown> {
  return {
    ...(record ?? {}),
    x: pos.x,
    y: pos.y,
    charge,
    manualRadius,
    manualRadiusM: blastRadius,
    radius: blastRadius,
  };
}
