/**
 * Zod schema for initial_state.team_dependencies. Server-only: the frontend
 * project does not depend on zod, and it typechecks shared/.
 */

import { z } from 'zod';
import { isInjectKey } from '../../../shared/injectKeySlug.js';
import {
  applyAnySugar,
  dependencyCatalogEntries,
  DEPENDENCY_ID,
  DEPENDENCY_KINDS,
  DEPENDENCY_SEVERITIES,
  DEPENDENCY_SOURCES,
  type DependencyCatalogEntry,
} from '../../../shared/teamDependencies.js';

const conditionKeySchema = z.string().trim().min(1);

const allGroupSchema = z.object({
  all: z.array(conditionKeySchema),
});

const thresholdGroupSchema = z.object({
  threshold: z.number().int().min(1),
  conditions: z.array(conditionKeySchema),
});

/** `{ any: [...] }` is stored as threshold 1. */
export const conditionGroupSchema = z.preprocess(
  applyAnySugar,
  z.union([allGroupSchema, thresholdGroupSchema]),
);

const brokenWhenSchema = conditionGroupSchema.superRefine((group, ctx) => {
  const keys = 'all' in group ? group.all : group.conditions;
  if (keys.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'broken_when needs at least one condition',
    });
  }
});

const teamRefSchema = z.object({
  team_uid: z
    .union([z.string().uuid(), z.null()])
    .optional()
    .transform((value) => value ?? null),
  team_name: z.string().trim().max(200),
});

const dueSchema = z.union([
  z.object({
    by_minute: z.number().int().min(0),
  }),
  z.object({
    after_inject_key: z.string().refine(isInjectKey, 'must be an inject key'),
    within_minutes: z.number().int().min(0),
  }),
]);

export const dependencyEdgeSchema = z.object({
  id: z.string().regex(DEPENDENCY_ID, 'id must match ^dep_[a-z0-9_]{1,56}$'),
  kind: z.enum(DEPENDENCY_KINDS),
  upstream: teamRefSchema,
  downstream: z.array(teamRefSchema).min(1),
  deliverable: z.string().trim().min(1).max(500),
  why: z.string().trim().max(2000).optional().default(''),
  due: dueSchema,
  broken_when: brokenWhenSchema,
  met_when: conditionGroupSchema.nullable().optional().transform((value) => value ?? null),
  lag_minutes: z.number().int().min(0).max(30),
  severity: z.enum(DEPENDENCY_SEVERITIES),
  consequence_keys: z
    .array(z.string().refine(isInjectKey, 'must be an inject key'))
    .optional()
    .default([]),
  source: z.enum(DEPENDENCY_SOURCES),
});

export const teamDependenciesSchema = z.object({
  v: z.literal(1),
  edges: z.array(dependencyEdgeSchema),
});

/** Picker rows. An unreadable document yields an empty list. */
export function catalogDependencies(document: unknown): DependencyCatalogEntry[] {
  const parsed = teamDependenciesSchema.safeParse(document);
  if (!parsed.success) return [];
  return dependencyCatalogEntries(parsed.data.edges);
}
