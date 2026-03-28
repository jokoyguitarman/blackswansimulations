/**
 * Checkpoint 2: Decision quality evaluation.
 * Evaluates decisions against professional standards, sector doctrine, hazard response
 * requirements, and operational specificity.
 *
 * Environmental layout consistency (capacity, exits, routes) is now handled by the
 * polygon/space-claim monitoring system which watches placed areas in real-time.
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { publishInjectToSession } from '../routes/injects.js';
import { getTeamCatalogAssets } from '../lib/teamAssetCatalog.js';
import type { Server as SocketServer } from 'socket.io';

export type EnvironmentalConsistencySeverity = 'low' | 'medium' | 'high';
export type EnvironmentalConsistencyErrorType =
  | 'capacity'
  | 'location'
  | 'flow'
  | 'space_contention'
  | 'other';

/** When consistent is false: "contradiction" = wrong vs standards; "below_standard" = short of sector standard; "infrastructure_gap" = acting without required facilities. */
export type EnvironmentalMismatchKind = 'contradiction' | 'below_standard' | 'infrastructure_gap';

/** When the decision is route-related: effect on counters (clear = fast/managed, slow = slower/congested but valid, congested = blocked/unmanaged or clearly suboptimal). */
export type RouteEffect = 'clear' | 'slow' | 'congested';

export interface EnvironmentalConsistencyResult {
  consistent: boolean;
  severity?: EnvironmentalConsistencySeverity;
  error_type?: EnvironmentalConsistencyErrorType;
  /** Set when consistent is false: contradiction = wrong/dangerous per standards; below_standard = short of sector standard. */
  mismatch_kind?: EnvironmentalMismatchKind;
  reason?: string;
  /** When the decision is route-related (evacuation, triage, transport): used for counter pressure in inject scheduler. */
  route_effect?: RouteEffect | null;
  /** false when the decision lacks operational specificity (missing locations, ratios, protocols, timelines). */
  specific?: boolean;
  /** Short phrases describing what is missing (e.g. "exit names", "marshal-to-evacuee ratio"). */
  missing_details?: string[];
  /** AI-generated in-world consequence narrative describing what happens because of the decision's shortcomings. */
  feedback?: string;
  /** AI-generated short in-world title for the consequence inject (e.g. "Overcrowding at Assembly North"). */
  consequence_title?: string;
  /** true when the decision proposes a forbidden/dangerous action (e.g. detonating a bomb, attacking people). */
  rejected?: boolean;
  /** In-world explanation of why the forbidden action cannot be carried out. */
  rejection_reason?: string;
}

/**
 * Build a prompt block describing infrastructure deployed on the map by all teams,
 * and what the author's team could still deploy from their asset catalog.
 */
async function buildInfrastructureContext(
  sessionId: string,
  authorTeamName?: string,
): Promise<string> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();

  const [{ data: assets }, { data: scenarioEquipment }] = await Promise.all([
    supabaseAdmin
      .from('placed_assets')
      .select('asset_type, label, team_name')
      .eq('session_id', sessionId)
      .eq('status', 'active'),
    session?.scenario_id
      ? supabaseAdmin
          .from('scenario_equipment')
          .select('equipment_type, label, applicable_teams')
          .eq('scenario_id', session.scenario_id)
      : Promise.resolve({
          data: [] as {
            equipment_type: string;
            label: string;
            applicable_teams: string[] | null;
          }[],
        }),
  ]);

  const baseCatalog = authorTeamName ? getTeamCatalogAssets(authorTeamName) : [];
  const catalog = [...baseCatalog];
  const catalogTypes = new Set(catalog.map((c) => c.asset_type));
  const teamKey = authorTeamName?.toLowerCase().replace(/[\s-]+/g, '_') ?? '';
  for (const eq of scenarioEquipment ?? []) {
    if (catalogTypes.has(eq.equipment_type)) continue;
    const teams = (eq.applicable_teams as string[] | null) ?? [];
    if (teams.length > 0 && teamKey) {
      const relevant = teams.some((t) => teamKey.includes(t) || t.includes(teamKey));
      if (!relevant) continue;
    }
    catalogTypes.add(eq.equipment_type);
    catalog.push({ asset_type: eq.equipment_type, label: eq.label });
  }

  if (!assets || assets.length === 0) {
    if (catalog.length === 0) return '';
    return `TEAM INFRASTRUCTURE STATUS:\nNo facilities or assets have been deployed on the map by any team.\n\nAssets available to ${authorTeamName} team but NOT yet deployed:\n${catalog.map((a) => `- ${a.label} (${a.asset_type})`).join('\n')}\n\n`;
  }

  const byTeam: Record<string, { asset_type: string; label: string | null; count: number }[]> = {};
  for (const a of assets) {
    const team = a.team_name as string;
    if (!byTeam[team]) byTeam[team] = [];
    const existing = byTeam[team].find((e) => e.asset_type === (a.asset_type as string));
    if (existing) {
      existing.count++;
    } else {
      byTeam[team].push({
        asset_type: a.asset_type as string,
        label: a.label as string | null,
        count: 1,
      });
    }
  }

  const lines: string[] = ['TEAM INFRASTRUCTURE STATUS:'];

  if (authorTeamName) {
    const teamAssets = byTeam[authorTeamName];
    if (teamAssets && teamAssets.length > 0) {
      lines.push(`\nAssets deployed by ${authorTeamName} team:`);
      for (const a of teamAssets) {
        const countStr = a.count > 1 ? `${a.count}x ` : '';
        lines.push(`- ${countStr}${a.label || a.asset_type}`);
      }
    } else {
      lines.push(`\n${authorTeamName} team has NOT deployed any assets on the map.`);
    }

    const deployedTypes = new Set((teamAssets ?? []).map((a) => a.asset_type));
    const notDeployed = catalog.filter((c) => !deployedTypes.has(c.asset_type));
    if (notDeployed.length > 0) {
      lines.push(`\nAssets available to ${authorTeamName} team but NOT yet deployed:`);
      for (const a of notDeployed) {
        lines.push(`- ${a.label} (${a.asset_type})`);
      }
    }
  }

  const otherTeams = Object.entries(byTeam).filter(([team]) => team !== authorTeamName);
  if (otherTeams.length > 0) {
    lines.push("\nOther teams' deployed infrastructure:");
    for (const [team, teamAssets] of otherTeams) {
      const assetList = teamAssets
        .map((a) => {
          const countStr = a.count > 1 ? `${a.count}x ` : '';
          return `${countStr}${a.label || a.asset_type}`;
        })
        .join(', ');
      lines.push(`- ${team}: ${assetList}`);
    }
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Build a prompt block describing casualties in the session with their conditions
 * and treatment ground truth, so the LLM can evaluate treatment decisions.
 * Only includes casualties that are not yet resolved/transported/deceased.
 */
async function buildCasualtyContext(sessionId: string): Promise<string> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session) return '';

  const elapsedMinutes = session.start_time
    ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
    : 0;

  const { data: casualties } = await supabaseAdmin
    .from('scenario_casualties')
    .select(
      'id, casualty_type, headcount, conditions, status, assigned_team, player_triage_color, floor_level',
    )
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .not('status', 'in', '("resolved","transported","deceased")')
    .lte('appears_at_minutes', elapsedMinutes);

  if (!casualties || casualties.length === 0) return '';

  const patients = casualties.filter((c) => (c.casualty_type as string) === 'patient');
  if (patients.length === 0) return '';

  const lines: string[] = ['ACTIVE CASUALTIES IN SCENE:'];

  for (const p of patients) {
    const conds = (p.conditions ?? {}) as Record<string, unknown>;
    const injuries = conds.injuries as
      | Array<{ type: string; severity: string; body_part: string; visible_signs?: string }>
      | undefined;
    const treatmentReqs = conds.treatment_requirements as
      | Array<{ intervention: string; priority: string; reason: string }>
      | undefined;
    const transportPrereqs = conds.transport_prerequisites as string[] | undefined;
    const contraindications = conds.contraindications as string[] | undefined;

    const injuryList = injuries?.map((i) => `${i.severity} ${i.type} (${i.body_part})`).join('; ');

    const patientLines: string[] = [];
    patientLines.push(
      `\nPatient [${(p.id as string).slice(0, 8)}] — Status: ${p.status}, Floor: ${p.floor_level ?? 'G'}`,
    );
    patientLines.push(
      `  Triage: ${conds.triage_color ?? 'unassessed'}${p.player_triage_color ? ` (player tagged: ${p.player_triage_color})` : ''}, Mobility: ${conds.mobility ?? 'unknown'}, Consciousness: ${conds.consciousness ?? 'unknown'}, Breathing: ${conds.breathing ?? 'unknown'}`,
    );
    if (injuryList) {
      patientLines.push(`  Injuries: ${injuryList}`);
    }
    if (conds.accessibility && conds.accessibility !== 'open') {
      patientLines.push(`  Access: ${conds.accessibility}`);
    }
    if (p.assigned_team) {
      patientLines.push(`  Assigned to: ${p.assigned_team}`);
    }

    if (treatmentReqs && treatmentReqs.length > 0) {
      patientLines.push(
        `  Required treatment: ${treatmentReqs.map((t) => `${t.intervention} [${t.priority}] — ${t.reason}`).join('; ')}`,
      );
    }
    if (transportPrereqs && transportPrereqs.length > 0) {
      patientLines.push(`  Must be done before transport: ${transportPrereqs.join(', ')}`);
    }
    if (contraindications && contraindications.length > 0) {
      patientLines.push(`  Contraindications: ${contraindications.join(', ')}`);
    }

    // Fallback: if no explicit treatment data, the LLM can infer from injuries
    if (!treatmentReqs && injuries && injuries.length > 0) {
      patientLines.push(
        '  (No explicit treatment requirements — evaluate based on injuries using standard pre-hospital care protocols)',
      );
    }

    lines.push(patientLines.join('\n'));
  }

  lines.push('');
  return lines.join('\n') + '\n';
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PPE_ASSET_TYPES = [
  'breathing_apparatus',
  'hazmat_suit',
  'fire_protective_gear',
  'ppe_medical',
  'safety_vest',
  'helmet',
  'scba',
  'turnout_gear',
  'respirator',
  'gas_mask',
];

const PERSONNEL_ASSET_TYPES = [
  'medic',
  'paramedic',
  'doctor',
  'nurse',
  'emt',
  'first_aider',
  'triage_officer',
  'firefighter',
  'hazmat_tech',
  'rescue',
  'marshal',
  'police',
  'security',
];

interface ZoneGroundTruth {
  zone_type: string;
  radius_m: number;
  ppe_required: string[];
  allowed_teams: string[];
  activities: string[];
}

function classifyByZone(
  dist: number,
  zones: ZoneGroundTruth[],
): { zone: ZoneGroundTruth; zoneName: string } | null {
  const sorted = [...zones].sort((a, b) => a.radius_m - b.radius_m);
  for (const z of sorted) {
    if (dist <= z.radius_m) return { zone: z, zoneName: z.zone_type };
  }
  return null;
}

/**
 * Build a prompt block describing active hazards, zone ground truth, player-drawn zones,
 * and which personnel are in which zones with what PPE — for the LLM to evaluate.
 */
async function buildHazardSafetyContext(sessionId: string): Promise<string> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id, start_time')
    .eq('id', sessionId)
    .single();
  if (!session) return '';

  const elapsedMinutes = session.start_time
    ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
    : 0;

  const { data: hazards } = await supabaseAdmin
    .from('scenario_hazards')
    .select(
      'id, hazard_type, location_lat, location_lng, floor_level, properties, equipment_requirements, personnel_requirements, status, zones',
    )
    .eq('scenario_id', session.scenario_id)
    .or(`session_id.is.null,session_id.eq.${sessionId}`)
    .in('status', ['active', 'escalating'])
    .lte('appears_at_minutes', elapsedMinutes);

  if (!hazards || hazards.length === 0) return '';

  const { data: assets } = await supabaseAdmin
    .from('placed_assets')
    .select('asset_type, label, team_name, geometry, properties')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  if (!assets || assets.length === 0) return '';

  // Separate player-drawn zone polygons from other assets
  const playerZones = assets.filter((a) => (a.asset_type as string) === 'hazard_zone');
  const otherAssets = assets.filter((a) => (a.asset_type as string) !== 'hazard_zone');

  const lines: string[] = ['HAZARD ZONE SAFETY STATUS:'];

  // Report whether players have established any zones
  if (playerZones.length === 0) {
    lines.push(
      '\nPLAYER ZONE ESTABLISHMENT: NO zones have been drawn by any team. Scene has NOT been formally assessed with hot/warm/cold zone designations.',
    );
  } else {
    const zoneSummary = playerZones.map((z) => {
      const props = z.properties as Record<string, unknown>;
      const classification = (props?.zone_classification as string) ?? 'unclassified';
      return `${classification.toUpperCase()} zone (by ${z.team_name})`;
    });
    lines.push(`\nPLAYER ZONE ESTABLISHMENT: ${zoneSummary.join(', ')}`);
  }

  for (const h of hazards) {
    const hazLat = Number(h.location_lat);
    const hazLng = Number(h.location_lng);
    const hazardType = (h.hazard_type as string).replace(/_/g, ' ');
    const zones = (h.zones ?? []) as ZoneGroundTruth[];
    const hasZoneData = zones.length > 0;
    const maxRadius = hasZoneData ? Math.max(...zones.map((z) => z.radius_m)) : 120;

    const hazardLines: string[] = [];
    hazardLines.push(`\nHazard: ${hazardType} [${h.status}] at floor ${h.floor_level ?? 'G'}`);

    if (hasZoneData) {
      hazardLines.push('  Ground truth zones (hidden from players):');
      for (const z of zones) {
        hazardLines.push(
          `    ${z.zone_type.toUpperCase()} (0-${z.radius_m}m): PPE required: [${z.ppe_required.join(', ')}], allowed teams: [${z.allowed_teams.join(', ')}], activities: [${z.activities.join(', ')}]`,
        );
      }
    }

    // Classify personnel and PPE by zone
    type PersonnelEntry = {
      type: string;
      label: string | null;
      team: string;
      dist: number;
      groundTruthZone: string;
    };
    type PPEEntry = { type: string; label: string | null; team: string; dist: number };

    const personnelInZones: PersonnelEntry[] = [];
    const ppeInRange: PPEEntry[] = [];

    for (const a of otherAssets) {
      const geom = a.geometry as Record<string, unknown>;
      if (geom?.type !== 'Point') continue;
      const coords = geom.coordinates as number[];
      if (!coords || coords.length < 2) continue;
      const dist = haversineM(hazLat, hazLng, coords[1], coords[0]);
      if (dist > maxRadius) continue;

      const assetLower = (a.asset_type as string).toLowerCase();
      const isPersonnel = PERSONNEL_ASSET_TYPES.some((t) => assetLower.includes(t));
      const isPPE = PPE_ASSET_TYPES.some((t) => assetLower.includes(t));

      if (isPersonnel) {
        const zoneMatch = hasZoneData ? classifyByZone(dist, zones) : null;
        personnelInZones.push({
          type: a.asset_type as string,
          label: a.label as string | null,
          team: a.team_name as string,
          dist: Math.round(dist),
          groundTruthZone: zoneMatch?.zoneName ?? (dist <= 120 ? 'unknown_proximity' : 'outside'),
        });
      }
      if (isPPE) {
        ppeInRange.push({
          type: a.asset_type as string,
          label: a.label as string | null,
          team: a.team_name as string,
          dist: Math.round(dist),
        });
      }
    }

    if (personnelInZones.length === 0) continue;

    if (hasZoneData) {
      const byZone: Record<string, PersonnelEntry[]> = {};
      for (const p of personnelInZones) {
        if (!byZone[p.groundTruthZone]) byZone[p.groundTruthZone] = [];
        byZone[p.groundTruthZone].push(p);
      }
      hazardLines.push('  Personnel by ground truth zone:');
      for (const [zoneName, personnel] of Object.entries(byZone)) {
        const zone = zones.find((z) => z.zone_type === zoneName);
        const ppeReq = zone ? zone.ppe_required.join(', ') : 'infer from hazard type';
        const allowedTeams = zone ? zone.allowed_teams.join(', ') : 'unknown';
        hazardLines.push(`    ${zoneName.toUpperCase()} ZONE:`);
        for (const p of personnel) {
          const teamAllowed = zone
            ? zone.allowed_teams.includes('all') ||
              zone.allowed_teams.some(
                (t) =>
                  p.team.toLowerCase().includes(t.toLowerCase()) ||
                  t.toLowerCase().includes(p.team.toLowerCase()),
              )
            : true;
          const accessFlag = teamAllowed ? '' : ' [UNAUTHORIZED TEAM]';
          hazardLines.push(`      - ${p.label || p.type} (${p.team}) at ${p.dist}m${accessFlag}`);
        }
        hazardLines.push(`      Required PPE for this zone: ${ppeReq}`);
        hazardLines.push(`      Allowed teams: ${allowedTeams}`);
      }
    } else {
      hazardLines.push(
        `  Personnel within 120m: ${personnelInZones.map((p) => `${p.label || p.type} (${p.team}, ${p.dist}m)`).join(', ')}`,
      );
      const eqReqs = (h.equipment_requirements ?? []) as Array<{
        equipment_type?: string;
        label?: string;
        critical?: boolean;
      }>;
      if (eqReqs.length > 0) {
        const reqList = eqReqs
          .map((e) => `${e.label || e.equipment_type}${e.critical ? ' [CRITICAL]' : ''}`)
          .join(', ');
        hazardLines.push(`  Required safety equipment: ${reqList}`);
      }
    }

    if (ppeInRange.length > 0) {
      hazardLines.push(
        `  Safety equipment deployed near hazard: ${ppeInRange.map((p) => `${p.label || p.type} (${p.team}, ${p.dist}m)`).join(', ')}`,
      );
    } else {
      hazardLines.push('  Safety equipment deployed near hazard: NONE');
    }

    lines.push(hazardLines.join('\n'));
  }

  if (lines.length <= 2) return '';

  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Evaluate whether a decision meets professional response standards, sector doctrine,
 * hazard-specific requirements, operational specificity, infrastructure readiness,
 * and personnel safety.
 *
 * A single focused LLM call that checks:
 *  - Standards compliance (sector doctrine, hazard response requirements)
 *  - Operational specificity (enough detail to execute on the ground)
 *  - Infrastructure readiness (required facilities deployed on the map)
 *  - Casualty treatment adequacy (matching patient needs)
 *  - Personnel safety (PPE near hazards)
 *  - Safety guardrails (forbidden actions)
 *
 * Returns consistent: true when the decision meets standards.
 * On AI failure/timeout, returns consistent to avoid blocking execute.
 */
export async function evaluateDecisionAgainstEnvironment(
  sessionId: string,
  decision: { id: string; title: string; description: string; type: string | null },
  openAiApiKey: string | undefined,
  incident?: { title: string; description: string } | null,
  teamName?: string,
  qualityFailureCount?: number,
): Promise<EnvironmentalConsistencyResult> {
  const consistentDefault: EnvironmentalConsistencyResult = { consistent: true };
  if (!openAiApiKey) return consistentDefault;

  try {
    const { data: session, error: sessionErr } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .single();
    if (sessionErr || !session) {
      logger.debug({ sessionId, error: sessionErr }, 'Session not found for decision evaluation');
      return consistentDefault;
    }

    const scenarioId = (session as { scenario_id: string }).scenario_id;
    const { data: scenario, error: scenarioErr } = await supabaseAdmin
      .from('scenarios')
      .select('id, description, insider_knowledge')
      .eq('id', scenarioId)
      .single();
    if (scenarioErr || !scenario) return consistentDefault;

    const insiderKnowledge = ((scenario as { insider_knowledge?: Record<string, unknown> })
      .insider_knowledge ?? {}) as Record<string, unknown>;

    // Load sector standards / team doctrines
    let sectorStandards: string | undefined;
    if (teamName) {
      const teamDoctrines = insiderKnowledge.team_doctrines as
        | Record<string, unknown[]>
        | undefined;
      if (
        teamDoctrines &&
        Array.isArray(teamDoctrines[teamName]) &&
        teamDoctrines[teamName].length > 0
      ) {
        const { standardsToPromptBlock } = await import('./warroomResearchService.js');
        sectorStandards = standardsToPromptBlock(
          teamDoctrines[teamName] as import('./warroomResearchService.js').StandardsFinding[],
        );
      }
    }
    if (!sectorStandards && typeof insiderKnowledge.sector_standards === 'string') {
      sectorStandards = insiderKnowledge.sector_standards;
    }

    // Detect hazard-response decisions and load hazard research data
    let hazardStandardsBlock = '';
    const hazardMatch = decision.description.match(/^\[Hazard Response:\s*(.+?)\]/);
    if (hazardMatch) {
      const hazardTypeRaw = hazardMatch[1].trim().replace(/\s+/g, '_').toLowerCase();
      const { data: matchingHazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select(
          'hazard_type, enriched_description, resolution_requirements, personnel_requirements, equipment_requirements, properties',
        )
        .eq('scenario_id', scenarioId)
        .ilike('hazard_type', `%${hazardTypeRaw}%`)
        .limit(3);

      if (matchingHazards?.length) {
        const parts: string[] = [];
        for (const h of matchingHazards) {
          const lines: string[] = [];
          lines.push(`Hazard type: ${(h.hazard_type as string).replace(/_/g, ' ')}`);
          if (h.enriched_description) {
            lines.push(`Situation: ${h.enriched_description}`);
          }
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          if (reqs && Object.keys(reqs).length > 0) {
            lines.push(`Resolution requirements: ${JSON.stringify(reqs)}`);
          }
          const personnel = h.personnel_requirements as Record<string, unknown> | null;
          if (personnel && Object.keys(personnel).length > 0) {
            lines.push(`Personnel requirements: ${JSON.stringify(personnel)}`);
          }
          const equipment = h.equipment_requirements as unknown[] | null;
          if (equipment && equipment.length > 0) {
            lines.push(`Equipment requirements: ${JSON.stringify(equipment)}`);
          }
          const props = (h.properties ?? {}) as Record<string, unknown>;
          const propEntries = Object.entries(props).filter(
            ([k]) => !['deterioration_stage', 'minutes_unaddressed'].includes(k),
          );
          if (propEntries.length > 0) {
            lines.push(`Properties: ${propEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
          }
          parts.push(lines.join('\n'));
        }
        hazardStandardsBlock = `HAZARD RESPONSE STANDARDS (the player is responding to this hazard — evaluate their response against these requirements):\n${parts.join('\n---\n')}\n\n`;
      }
    }

    const [infrastructureBlock, casualtyBlock, hazardSafetyBlock] = await Promise.all([
      buildInfrastructureContext(sessionId, teamName),
      buildCasualtyContext(sessionId),
      buildHazardSafetyContext(sessionId),
    ]);

    const incidentUserBlock =
      incident?.title != null || incident?.description != null
        ? `\nINCIDENT (this decision is in response to):\nTitle: ${incident.title ?? ''}\nDescription: ${incident.description ?? ''}\n\n`
        : '';
    const sectorStandardsLine = sectorStandards
      ? `Sector standards / team doctrines:\n${sectorStandards}\n\n`
      : '';
    const teamRoleLine = teamName ? `TEAM ROLE: ${teamName}\n\n` : '';
    const escalationLevel = qualityFailureCount ?? 0;
    const escalationLine = `ESCALATION LEVEL: ${escalationLevel} (${escalationLevel === 0 ? 'first offence — minor operational friction' : escalationLevel === 1 ? 'second offence — significant in-world problems' : 'third+ offence — critical in-world damage and casualties'})\n\n`;

    const systemPrompt = `You are an expert crisis management standards evaluator for a training exercise. Evaluate whether this decision meets professional response standards and has enough operational specificity to be executed on the ground.

=== HAZARD RESPONSE EVALUATION ===
When "HAZARD RESPONSE STANDARDS" are provided, the decision is a direct response to a specific hazard. You MUST rigorously evaluate whether the proposed response meets the hazard's resolution requirements, personnel requirements, and equipment requirements. Apply these rules strictly:

1. INCORRECT APPROACH: A response that proposes incorrect equipment or procedures for the hazard type (e.g. water on a Class B/electrical fire, improvised tools instead of professional equipment) MUST be marked consistent: false with mismatch_kind "contradiction". "Pour water from buckets" on ANY fire is a contradiction — professional fire suppression equipment (extinguishers of the correct class, fire hoses, foam systems) is required. Improvised methods using buckets, bottles, or non-firefighting water sources are NEVER acceptable.
2. IMPROVISED / AMATEUR RESPONSE: If the hazard standards specify professional equipment (e.g. CO2 extinguisher, foam extinguisher, fire hose) and the decision instead proposes improvised civilian methods (e.g. "pour water from buckets/restrooms/bottles", "use blankets to smother", "fan the smoke away"), mark consistent: false with mismatch_kind "below_standard" at minimum. If the improvised method could worsen the hazard (e.g. water on a grease/electrical fire), use mismatch_kind "contradiction".
3. PROFESSIONAL STANDARD: Fire response decisions MUST involve calling the fire service (e.g. SCDF, fire brigade) OR using professional fire suppression equipment already on-site. Civilian improvisation does NOT meet professional fire response standards regardless of fire class.

=== STANDARDS COMPLIANCE ===
When sector standards or team doctrines are provided, evaluate whether the decision meets their key requirements:
- consistent: false with mismatch_kind "below_standard" when the decision's approach falls short of professional standards (e.g. improvised methods instead of professional equipment, ignoring required procedures).
- consistent: false with mismatch_kind "contradiction" when the decision proposes something directly wrong or dangerous per the standards (e.g. wrong equipment class, contradicting a mandatory procedure).
- consistent: true when the decision follows or reasonably approximates the standards.
- severity: "low" = minor shortfall; "medium" = significant gap; "high" = dangerous deviation.
- reason: when consistent is false, write an IN-WORLD CONSEQUENCE — describe what is happening on the ground, NOT what the player did wrong. Match the ESCALATION LEVEL.
- consequence_title: short (3-8 word) in-world headline when consistent is false.

=== OPERATIONAL SPECIFICITY ===
Evaluate whether the decision is OPERATIONALLY SPECIFIC enough to be executed on the ground.

Specificity requirements by team role:
- Evacuation: specific exit names/IDs, flow control method, marshal-to-evacuee ratios, staging/assembly areas, ground zero perimeter distance, phased evacuation order if applicable
- Triage: named triage zones/areas, triage protocol (e.g. START, SALT, Triage Sieve), staff-to-patient ratios, casualty categorisation zones (Red/Yellow/Green), transport priorities and destination hospitals
- Media: named spokesperson, statement content or key messages, press conference location or channel, information update frequency, misinformation rebuttal points
- Hazard Response: specific equipment type and class (e.g. "ABC dry chemical extinguisher" not just "water"), trained personnel to deploy it, approach method (upwind, from safe distance, etc.), safety perimeter, containment procedure, whether external services (fire brigade, HAZMAT) need to be called

Set "specific": false when the decision gives general/vague instructions without naming concrete details. Set "specific": true when the decision names enough specifics to be executed without further clarification.

CRITICAL RULE: Do NOT tell the player what is missing or what they should do. Describe the IN-WORLD CONSEQUENCE of their vague orders.

When "specific" is false, the "feedback" MUST be an in-world consequence narrative matching the ESCALATION LEVEL:
- ESCALATION 0: minor friction from unclear orders. E.g. "Field teams are attempting to fight the fire with water from restroom buckets. The flames are intensifying — the improvised approach is having no effect and smoke is filling the corridor." Use the scenario's actual details.
- ESCALATION 1: significant in-world problem. E.g. "The fire has spread to adjacent areas while personnel attempted improvised suppression without proper equipment. Smoke inhalation cases are being reported among nearby evacuees."
- ESCALATION 2+: critical in-world damage. E.g. "The uncontrolled fire has engulfed the east wing. Multiple burn casualties are being reported. Structural integrity is compromised and emergency evacuation of the building has been triggered."

When "specific" is false:
- "missing_details": array of 2-5 short phrases (internal use only, NOT shown to player).
- "feedback": one paragraph (2-4 sentences) — in-world consequence narrative. Reference the actual scenario — do NOT be generic.
- "consequence_title": short (3-8 word) in-world field report headline.

=== INFRASTRUCTURE READINESS ===
When "TEAM INFRASTRUCTURE STATUS" is provided, evaluate whether the team has deployed the necessary facilities and assets on the map to support their decision. Consider:

1. CRITICAL GAP: The decision requires operational infrastructure that has NOT been deployed on the map (e.g., ordering patient treatment/transport without a triage tent or field hospital, ordering decontamination without a decon zone, directing evacuees to an assembly point that doesn't exist, ordering fire suppression without water point or fire truck staging). Set consistent: false with mismatch_kind "infrastructure_gap".
2. CROSS-TEAM GAP: The decision relies on infrastructure that another team should have deployed but hasn't (e.g., requesting casualty decontamination but no decon zone exists from any team). This is also an infrastructure_gap.
3. PLANNING EXCEPTION: Decisions that ARE the infrastructure setup action (e.g., "establish a triage zone", "set up decon area", "deploy assembly point at location X") should NOT be penalized — they are creating the infrastructure. Only penalize decisions that ASSUME infrastructure already exists when it does not.

When mismatch_kind is "infrastructure_gap":
- reason: in-world consequence of acting without proper infrastructure. Match the ESCALATION LEVEL.
- consequence_title: short (3-8 word) in-world headline.
- severity: "medium" for partial gaps, "high" for critical missing infrastructure that endangers lives.

=== CASUALTY TREATMENT EVALUATION ===
When "ACTIVE CASUALTIES IN SCENE" is provided, evaluate whether the decision provides adequate medical care for the patients it references. Apply professional pre-hospital care standards:

1. INADEQUATE TREATMENT: The decision orders treatment or transport of a patient but skips critical interventions required by their injuries. Examples:
   - Transporting a fracture patient without splinting first (risk of vascular/nerve damage)
   - Moving a patient without controlling active bleeding (hemorrhagic shock risk)
   - Failing to provide airway management for a patient with labored/absent breathing
   - Transporting a potential spinal injury without immobilization
   - Not providing burn dressings or fluid resuscitation for burn patients
   Set consistent: false with mismatch_kind "below_standard". Severity based on risk to patient.

2. DANGEROUS TREATMENT: The decision does something contraindicated for a specific patient. Examples:
   - Applying a tourniquet to a crush injury without medical oversight (reperfusion syndrome)
   - Moving a spinal injury patient without immobilization
   - Giving fluids to a patient with suspected internal injuries without medical authority
   Set consistent: false with mismatch_kind "contradiction". Severity: "high".

3. ADEQUATE: The decision appropriately addresses the patient's injuries, or the decision does not involve specific patient care. No penalty.

4. RELEVANCE: Only evaluate casualty treatment when the decision DIRECTLY involves patient care, treatment, or transport. Generic command decisions, infrastructure setup, or communication orders should NOT be evaluated against casualty data.

When treatment_requirements or transport_prerequisites are listed for a patient, use them as ground truth. When they are absent, infer required care from the injury data using standard pre-hospital protocols (PHTLS, ITLS, TCCC).

=== ZONE MANAGEMENT & SAFETY ===
When "HAZARD ZONE SAFETY STATUS" is provided, evaluate four dimensions following ICS/NIMS zone protocol. The game does NOT hard-block any action — all decisions proceed, but violations produce consequence injects.

A. ZONE ESTABLISHMENT:
- If "PLAYER ZONE ESTABLISHMENT: NO zones" is reported AND teams are already operating near hazards, flag as below_standard: "Scene not formally assessed — no hot/warm/cold zone boundaries established. Teams are operating blind without proper scene assessment."
- If zones are drawn but critical zone types are missing (e.g., hot zone exists but no warm zone for decon), flag as below_standard with specific feedback.
- Do NOT penalize if no personnel are near hazards yet (zones aren't needed until operations begin).

B. ZONE ACCESS VIOLATIONS:
- Personnel from UNAUTHORIZED teams in the HOT ZONE: Set consistent: false, mismatch_kind: "contradiction", severity: "high". Generate a severe consequence narrative (e.g., "medic suffered burns entering the hot zone without proper training or equipment — team member down").
- Personnel from unauthorized teams in the WARM ZONE: Set consistent: false, mismatch_kind: "below_standard", severity: "medium". Moderate consequence (e.g., "responder experiencing respiratory symptoms from warm zone exposure").
- COLD ZONE: open to all teams, no access penalty.
- When "[UNAUTHORIZED TEAM]" flag appears in the data, the team is definitively not allowed in that zone.

C. PPE FOR ZONE:
- In HOT ZONE without critical PPE (as listed in zone ground truth): mismatch_kind "contradiction", severity "high" — immediate life threat.
- In WARM ZONE without required PPE: mismatch_kind "below_standard", severity "high" — health risk from exposure.
- COLD ZONE: no special PPE required beyond standard medical PPE.
- When zone PPE requirements are listed, use them as ground truth. When absent, infer from hazard type (fire → SCBA + turnout gear; chemical → hazmat suit + respirator; structural → helmet + safety gear; smoke → breathing apparatus).

D. PATIENT HANDOFF CHAIN:
- Treating/triaging a patient inside the HOT zone instead of extrication-first: below_standard — "patients in the hot zone should be rapidly extricated to the warm/cold zone before treatment begins."
- Moving a patient from hot zone directly to cold zone, skipping decontamination in a chemical/HAZMAT scenario: below_standard — "patient requires decontamination in the warm zone before transfer to treatment."
- Proper chain followed (extricate from hot → stabilize in warm → treat in cold): no penalty.

ESCALATING CONSEQUENCES (no hard blocks):
- Wrong zone + wrong team + no PPE = "contradiction" + severe narrative (injuries, team member down)
- Wrong zone + right team + partial PPE = "below_standard" + moderate consequence
- No zones established + actions proceeding = "below_standard" + "operating without scene assessment"
- Correct zone protocol followed = consistent: true

RELEVANCE: Only evaluate zone safety when decisions involve deploying people near active hazards OR when hazard zone data shows personnel in zones. Decisions about infrastructure setup in the cold zone or away from hazards should NOT be penalized for zone issues.

=== SAFETY GUARDRAILS ===
FORBIDDEN ACTIONS (set "rejected": true with "rejection_reason"):
- Directly handling, detonating, disarming, or triggering explosive devices
- Intentionally causing harm to people
- Ordering emergency services to stand down without authorisation
- Deliberately endangering civilians
- Impersonating emergency services

Contacting or requesting bomb disposal teams, EOD, SPF, or SCDF is ALLOWED.

When "rejected" is true, set "rejection_reason" to an in-world explanation. Set consistent: false, severity: "high", specific: false.

=== OUTPUT FORMAT ===
Return ONLY valid JSON:
{
  "rejected": boolean,
  "rejection_reason": "..." (only if rejected),
  "consistent": boolean,
  "mismatch_kind": "contradiction"|"below_standard"|"infrastructure_gap" (only if consistent is false),
  "severity": "low"|"medium"|"high" (only if consistent is false),
  "error_type": "other" (only if consistent is false),
  "reason": "..." (only if consistent is false — in-world consequence),
  "consequence_title": "..." (when consistent is false OR specific is false),
  "specific": boolean,
  "missing_details": ["..."] (only if specific is false),
  "feedback": "..." (only if specific is false — in-world consequence)
}`;

    const userPrompt = `${hazardStandardsBlock}${sectorStandardsLine}${teamRoleLine}${escalationLine}${infrastructureBlock}${casualtyBlock}${hazardSafetyBlock}${incidentUserBlock}DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate this decision against professional response standards, operational specificity, infrastructure readiness, casualty treatment adequacy, and personnel safety. ALL "reason" and "feedback" text must be IN-WORLD CONSEQUENCES only — describe what is happening on the ground as a result of the decision. NEVER tell the player what is wrong, what they should do, or what is missing.

Return JSON only.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI API error in decision standards evaluation');
      return consistentDefault;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return consistentDefault;

    const parsed = JSON.parse(content) as {
      rejected?: boolean;
      rejection_reason?: string;
      consistent?: boolean;
      mismatch_kind?: string;
      severity?: string;
      error_type?: string;
      reason?: string;
      consequence_title?: string;
      specific?: boolean;
      missing_details?: string[];
      feedback?: string;
    };

    const isRejected = parsed.rejected === true;
    const rejectionReason =
      typeof parsed.rejection_reason === 'string' ? parsed.rejection_reason.trim() : undefined;

    if (isRejected && rejectionReason) {
      return {
        consistent: false,
        severity: 'high',
        error_type: 'other',
        mismatch_kind: 'contradiction',
        reason: rejectionReason,
        consequence_title:
          typeof parsed.consequence_title === 'string'
            ? parsed.consequence_title.trim()
            : 'Action cannot be carried out',
        specific: false,
        rejected: true,
        rejection_reason: rejectionReason,
      };
    }

    const consistent = parsed.consistent === true;
    const specific = parsed.specific !== false;
    const feedback =
      typeof parsed.feedback === 'string' && parsed.feedback.trim()
        ? parsed.feedback.trim()
        : undefined;
    const missing_details = Array.isArray(parsed.missing_details)
      ? (parsed.missing_details as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const consequence_title =
      typeof parsed.consequence_title === 'string' && parsed.consequence_title.trim()
        ? parsed.consequence_title.trim()
        : undefined;

    if (consistent && specific) {
      return { consistent: true, specific: true };
    }

    if (consistent && !specific) {
      return {
        consistent: true,
        specific: false,
        missing_details,
        feedback,
        consequence_title,
      };
    }

    // consistent: false — standards failure
    const rawKind = (typeof parsed.mismatch_kind === 'string' ? parsed.mismatch_kind : '')
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, '_');
    const mismatch_kind: EnvironmentalMismatchKind =
      rawKind === 'below_standard'
        ? 'below_standard'
        : rawKind === 'infrastructure_gap'
          ? 'infrastructure_gap'
          : 'contradiction';
    let severity = ['low', 'medium', 'high'].includes(parsed.severity ?? '')
      ? (parsed.severity as EnvironmentalConsistencySeverity)
      : 'medium';
    if (mismatch_kind === 'below_standard' && severity === 'high') {
      severity = 'medium';
    }
    const error_type = ['capacity', 'location', 'flow', 'space_contention', 'other'].includes(
      parsed.error_type ?? '',
    )
      ? (parsed.error_type as EnvironmentalConsistencyErrorType)
      : 'other';
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 500)
        : 'Decision does not meet professional response standards.';

    return {
      consistent: false,
      severity,
      error_type,
      mismatch_kind,
      reason,
      consequence_title,
      specific,
      missing_details: specific ? undefined : missing_details,
      feedback: specific ? undefined : feedback,
    };
  } catch (err) {
    logger.warn(
      { err, sessionId, decisionId: decision.id },
      'evaluateDecisionAgainstEnvironment failed, treating as consistent',
    );
    return consistentDefault;
  }
}

/**
 * Publish a standards-failure inject for the team(s) that made the decision.
 * Fires for contradictions (wrong approach per standards).
 * Below-standard (close but not meeting standard) does not fire an inject.
 */
export async function createAndPublishEnvironmentalMismatchInject(
  params: {
    sessionId: string;
    scenarioId: string;
    trainerId: string;
    authorTeamNames: string[];
    result: EnvironmentalConsistencyResult;
    decisionId: string;
  },
  io: SocketServer,
): Promise<void> {
  const { sessionId, scenarioId, trainerId, authorTeamNames, result } = params;
  if (result.consistent) return;
  if (result.mismatch_kind === 'below_standard') return;

  const title = result.consequence_title ?? 'Decision at odds with response standards';
  const content = result.reason ?? 'Decision does not meet professional response standards.';
  const severity = result.severity === 'high' ? 'high' : 'medium';
  const requiresResponse = result.severity === 'high' || result.severity === 'medium';
  const targetTeams = authorTeamNames.length > 0 ? authorTeamNames : null;
  const injectScope =
    targetTeams && targetTeams.length > 0 ? ('team_specific' as const) : ('universal' as const);

  try {
    const { data: createdInject, error: createError } = await supabaseAdmin
      .from('scenario_injects')
      .insert({
        scenario_id: scenarioId,
        trigger_time_minutes: null,
        trigger_condition: null,
        type: 'field_update',
        title,
        content,
        severity,
        affected_roles: [],
        inject_scope: injectScope,
        target_teams: targetTeams,
        requires_response: requiresResponse,
        requires_coordination: false,
        ai_generated: true,
        triggered_by_user_id: null,
      })
      .select()
      .single();

    if (createError) {
      logger.warn({ error: createError, sessionId }, 'Failed to create standards failure inject');
      return;
    }
    if (createdInject) {
      await publishInjectToSession(createdInject.id, sessionId, trainerId, io);
      logger.info(
        {
          sessionId,
          injectId: createdInject.id,
          severity: result.severity,
          mismatch_kind: result.mismatch_kind,
        },
        'Standards failure inject published',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Error publishing standards failure inject');
  }
}
