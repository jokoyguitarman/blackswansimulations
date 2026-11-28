import { z } from 'zod';
import { RIVAL_DESCRIPTION_MAX } from '../rivalDescription.js';

/**
 * Wire schemas for the multi-org War Room. One copy, imported by the routes
 * and by the durable build request (durable scenario builds §3 / §4.2).
 */

export const organisationInputSchema = z.object({
  org_key: z.string().optional(),
  display_name: z.string().min(1).max(120),
  short_name: z.string().max(20).optional(),
  country: z.string().min(1).max(80),
  city: z.string().max(80).optional(),
  kind: z.enum(['company', 'office', 'agency', 'ngo', 'other']).optional(),
  facebook_handle: z.string().max(60).optional(),
  x_handle: z.string().max(60).optional(),
  logo_url: z.string().max(2000).optional(),
  is_primary: z.boolean(),
  team_roster: z.array(
    z.object({
      team_name: z.string().min(1).max(60),
      description: z.string().max(2000).optional(),
      is_custom: z.boolean().optional(),
      is_public_voice: z.boolean().optional(),
    }),
  ),
  operation: z.enum(['players', 'ai']).optional(),
});

export const organisationsSchema = z.array(organisationInputSchema).min(1);

export const pressureOrganisationsSchema = z.array(
  z.object({
    org_key: z.string().optional(),
    display_name: z.string().min(1).max(120),
    kind: z.enum(['union', 'regulator', 'ngo', 'community_group', 'political']),
    country: z.string().min(1).max(80),
    city: z.string().max(80).optional(),
    register: z.enum(['statutory', 'advocacy', 'grassroots', 'political']).optional(),
    wants: z.string().max(300).optional(),
    facebook_handle: z.string().max(60).optional(),
    x_handle: z.string().max(60).optional(),
    spokesperson_stakeholder_id: z.string().max(80).optional(),
    targets_org_keys: z.array(z.string()).optional(),
  }),
);

export const competitorsSchema = z.array(
  z.object({
    name: z.string().min(1).max(120),
    country: z.string().min(1).max(80),
    facebook_handle: z.string().max(60).optional(),
    x_handle: z.string().max(60).optional(),
    org_key: z.string().optional(),
    description: z.string().trim().max(RIVAL_DESCRIPTION_MAX).optional(),
  }),
);

/** Legacy single-roster field on /generate-storyline. Distinct from an org's nested roster. */
export const teamRosterSchema = z
  .array(
    z.object({
      team_name: z.string().min(2).max(60),
      description: z.string().max(2000).optional(),
      is_custom: z.boolean().optional(),
      is_public_voice: z.boolean().optional(),
    }),
  )
  .min(2);

export const teamCharterWireSchema = z.object({
  team_name: z.string(),
  mission: z.string(),
  responsibilities: z.array(z.string()),
  out_of_lane: z.array(z.string()).optional(),
  scoring_rubric: z.string().optional(),
  expected_actions: z.array(z.unknown()).optional(),
  min_participants: z.number().optional(),
  max_participants: z.number().optional(),
  is_custom: z.boolean().optional(),
  can_post_publicly: z.boolean().optional(),
  sentiment_dimension: z.string().optional(),
  org_key: z.string().nullable().optional(),
  function_key: z.string().optional(),
  country: z.string().optional(),
  short_name: z.string().optional(),
});
export type TeamCharterWire = z.infer<typeof teamCharterWireSchema>;
