export interface OrgPageBatch<A, C> {
  allies: A[];
  competitors: C[];
  /** Ask the model to invent one rival. At most one batch in a plan sets this. */
  inventRival: boolean;
}

/**
 * Split allies and rivals into page-generation calls. Allies come first, then
 * rivals, and each batch numbers its own A1 / C1 refs. The invent-a-rival
 * instruction is attached to the first batch only, and only when the trainer
 * named no rivals and invention is allowed.
 */
export function batchOrgPages<A, C>(
  allies: readonly A[],
  competitors: readonly C[],
  batchSize: number,
  inventWhenNoNamedRivals: boolean,
): Array<OrgPageBatch<A, C>> {
  const size = Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : 1;
  type Item = { role: 'ally'; value: A } | { role: 'competitor'; value: C };
  const items: Item[] = [
    ...allies.map((value) => ({ role: 'ally' as const, value })),
    ...competitors.map((value) => ({ role: 'competitor' as const, value })),
  ];
  const invent = inventWhenNoNamedRivals && competitors.length === 0;
  if (items.length === 0) {
    return invent ? [{ allies: [], competitors: [], inventRival: true }] : [];
  }
  const batches: Array<OrgPageBatch<A, C>> = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const slice = items.slice(offset, offset + size);
    batches.push({
      allies: slice
        .filter((item): item is { role: 'ally'; value: A } => item.role === 'ally')
        .map((item) => item.value),
      competitors: slice
        .filter((item): item is { role: 'competitor'; value: C } => item.role === 'competitor')
        .map((item) => item.value),
      inventRival: false,
    });
  }
  if (invent) batches[0].inventRival = true;
  return batches;
}

export const INVENT_RIVAL_LINE =
  'NO competitors were named: INVENT exactly ONE realistic rival/competitor brand appropriate to this crisis. Mark it auto_generated and give it ref "NEW".';
