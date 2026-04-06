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
import { haversineM, pointInPolygon, polygonBoundingBox } from './geoUtils.js';

/**
 * Fuzzy team-doctrine lookup: tries exact match, then case-insensitive, then
 * partial substring match (e.g. "police" matches "Singapore Police Force").
 * Returns the findings array for the first match found, or [].
 */
function resolveTeamDoctrines(
  teamDoctrines: Record<string, unknown[]>,
  teamName: string,
): unknown[] {
  if (Array.isArray(teamDoctrines[teamName]) && teamDoctrines[teamName].length > 0) {
    return teamDoctrines[teamName];
  }
  const lowerName = teamName.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [key, findings] of Object.entries(teamDoctrines)) {
    if (
      key.toLowerCase().replace(/[\s-]+/g, '_') === lowerName &&
      Array.isArray(findings) &&
      findings.length > 0
    ) {
      return findings;
    }
  }
  for (const [key, findings] of Object.entries(teamDoctrines)) {
    const lowerKey = key.toLowerCase().replace(/[\s-]+/g, '_');
    if (
      (lowerKey.includes(lowerName) || lowerName.includes(lowerKey)) &&
      Array.isArray(findings) &&
      findings.length > 0
    ) {
      return findings;
    }
  }
  return [];
}

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
      .select('asset_type, label, team_name, properties')
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

  type AssetEntry = {
    asset_type: string;
    label: string | null;
    count: number;
    properties?: Record<string, unknown>;
  };
  const byTeam: Record<string, AssetEntry[]> = {};
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
        properties: (a.properties as Record<string, unknown>) ?? undefined,
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
        let detail = `- ${countStr}${a.label || a.asset_type}`;
        if (a.properties && Object.keys(a.properties).length > 0) {
          const props = a.properties;
          if (props.personnel)
            detail += ` | Personnel: ${Array.isArray(props.personnel) ? (props.personnel as string[]).join(', ') : props.personnel}`;
          if (props.equipment)
            detail += ` | Equipment: ${Array.isArray(props.equipment) ? (props.equipment as string[]).join(', ') : props.equipment}`;
          if (props.capacity) detail += ` | Capacity: ${props.capacity}`;
          if (props.direction_intent) {
            const di = props.direction_intent as { action?: string; destination?: string };
            detail += ` | Direction: ${di.action} → ${di.destination}`;
          }
        }
        lines.push(detail);
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
    .eq('session_id', sessionId)
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
    const idealSequence = conds.ideal_response_sequence as
      | Array<{ step: number; action: string; detail: string }>
      | undefined;
    const requiredPpe = conds.required_ppe as string[] | undefined;
    const requiredEquipment = conds.required_equipment as
      | Array<{ item: string; quantity: number; purpose: string }>
      | undefined;
    const expectedTime = conds.expected_time_to_treat_minutes as number | undefined;

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
    if (idealSequence && idealSequence.length > 0) {
      patientLines.push(
        `  Ideal response sequence: ${idealSequence.map((s) => `${s.step}. ${s.action}: ${s.detail}`).join(' → ')}`,
      );
    }
    if (requiredPpe && requiredPpe.length > 0) {
      patientLines.push(`  Required PPE for responder: ${requiredPpe.join(', ')}`);
    }
    if (requiredEquipment && requiredEquipment.length > 0) {
      patientLines.push(
        `  Required equipment: ${requiredEquipment.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
      );
    }
    if (expectedTime) {
      patientLines.push(`  Expected treatment time: ~${expectedTime} minutes`);
    }

    const recommendedTransport = conds.recommended_transport as string | undefined;
    if (recommendedTransport) {
      patientLines.push(`  Recommended transport: ${recommendedTransport}`);
    }

    const detTimeline = conds.deterioration_timeline as
      | Array<{ at_minutes: number; description: string }>
      | undefined;
    if (detTimeline && detTimeline.length > 0) {
      patientLines.push(
        `  Deterioration if untreated: ${detTimeline.map((d) => `+${d.at_minutes}min: ${d.description}`).join('; ')}`,
      );
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
  polygon?: [number, number][];
  ppe_required: string[];
  allowed_teams: string[];
  activities: string[];
}

function classifyByZone(
  dist: number,
  zones: ZoneGroundTruth[],
  assetLat?: number,
  assetLng?: number,
): { zone: ZoneGroundTruth; zoneName: string } | null {
  const sorted = [...zones].sort((a, b) => a.radius_m - b.radius_m);
  for (const z of sorted) {
    if (z.polygon && assetLat != null && assetLng != null) {
      if (pointInPolygon(assetLat, assetLng, z.polygon)) return { zone: z, zoneName: z.zone_type };
    } else if (dist <= z.radius_m) {
      return { zone: z, zoneName: z.zone_type };
    }
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
      'id, hazard_type, location_lat, location_lng, floor_level, properties, equipment_requirements, personnel_requirements, resolution_requirements, status, zones',
    )
    .eq('scenario_id', session.scenario_id)
    .eq('session_id', sessionId)
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

  // Unified zones: find the first hazard that has non-empty zones (zones are stored on primary hazard only)
  const unifiedZones =
    hazards.map((h) => (h.zones ?? []) as ZoneGroundTruth[]).find((z) => z.length > 0) ?? [];

  for (const h of hazards) {
    const hazLat = Number(h.location_lat);
    const hazLng = Number(h.location_lng);
    const hazardType = (h.hazard_type as string).replace(/_/g, ' ');
    const zones = unifiedZones;
    const hasZoneData = zones.length > 0;
    const hasPolygons = zones.some((z) => z.polygon?.length);
    const maxRadius = hasZoneData ? Math.max(...zones.map((z) => z.radius_m)) : 120;

    let outerBBox: ReturnType<typeof polygonBoundingBox> | undefined;
    if (hasPolygons) {
      const outerZone = [...zones].sort((a, b) => b.radius_m - a.radius_m)[0];
      if (outerZone?.polygon?.length) {
        outerBBox = polygonBoundingBox(outerZone.polygon);
      }
    }

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
      const assetLat = coords[1];
      const assetLng = coords[0];
      const dist = haversineM(hazLat, hazLng, assetLat, assetLng);

      if (outerBBox) {
        const margin = 0.001;
        if (
          assetLat < outerBBox.minLat - margin ||
          assetLat > outerBBox.maxLat + margin ||
          assetLng < outerBBox.minLng - margin ||
          assetLng > outerBBox.maxLng + margin
        ) {
          if (dist > maxRadius) continue;
        }
      } else if (dist > maxRadius) {
        continue;
      }

      const assetLower = (a.asset_type as string).toLowerCase();
      const isPersonnel = PERSONNEL_ASSET_TYPES.some((t) => assetLower.includes(t));
      const isPPE = PPE_ASSET_TYPES.some((t) => assetLower.includes(t));

      if (isPersonnel) {
        const zoneMatch = hasZoneData ? classifyByZone(dist, zones, assetLat, assetLng) : null;
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

    // Ideal response sequence and PPE from resolution requirements
    const resReqs = (h.resolution_requirements ?? {}) as Record<string, unknown>;
    const hazardIdealSeq = resReqs.ideal_response_sequence as
      | Array<{ step: number; action: string; detail: string; responsible_team?: string }>
      | undefined;
    const hazardReqPpe = resReqs.required_ppe as
      | Array<{ item: string; for_role?: string; mandatory?: boolean }>
      | undefined;
    const estResolution = resReqs.estimated_resolution_minutes as number | undefined;

    if (hazardIdealSeq && hazardIdealSeq.length > 0) {
      hazardLines.push(
        `  Ideal response sequence: ${hazardIdealSeq.map((s) => `${s.step}. ${s.action}${s.responsible_team ? ` [${s.responsible_team}]` : ''}: ${s.detail}`).join(' → ')}`,
      );
    }
    if (hazardReqPpe && hazardReqPpe.length > 0) {
      hazardLines.push(
        `  Required PPE for responders: ${hazardReqPpe.map((p) => `${p.item}${p.for_role ? ` (${p.for_role})` : ''}${p.mandatory ? ' [MANDATORY]' : ''}`).join('; ')}`,
      );
    }
    if (estResolution) {
      hazardLines.push(`  Expected resolution time: ~${estResolution} minutes`);
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

interface FacilityChallenge {
  challenge_type: string;
  description: string;
  severity: string;
  affected_route?: string;
  alternative?: string;
}

async function buildFacilityChallengesContext(sessionId: string): Promise<string> {
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('scenario_id')
    .eq('id', sessionId)
    .single();
  if (!session) return '';

  const scenarioId = (session as { scenario_id: string }).scenario_id;
  const { data: locations } = await supabaseAdmin
    .from('scenario_locations')
    .select('label, location_type, conditions')
    .eq('scenario_id', scenarioId)
    .eq('pin_category', 'poi');

  if (!locations || locations.length === 0) return '';

  const lines: string[] = [
    'FACILITY ENVIRONMENTAL CHALLENGES (hidden ground truth — evaluate player decisions against these):',
  ];
  let hasChallenges = false;

  for (const loc of locations) {
    const conditions = (loc.conditions ?? {}) as Record<string, unknown>;
    const challenges = conditions.environmental_challenges as FacilityChallenge[] | undefined;
    if (!challenges || !Array.isArray(challenges) || challenges.length === 0) continue;

    hasChallenges = true;
    lines.push(`\n${loc.label} (${(loc.location_type as string).replace(/_/g, ' ')}):`);
    for (const c of challenges) {
      let line = `  - [${c.severity?.toUpperCase()}] ${c.challenge_type.replace(/_/g, ' ')}: ${c.description}`;
      if (c.affected_route) line += ` (affected route: ${c.affected_route})`;
      if (c.alternative) line += ` (alternative: ${c.alternative})`;
      lines.push(line);
    }
  }

  if (!hasChallenges) return '';

  lines.push('');
  lines.push(
    "If the player's decision references a facility above and ignores or contradicts its challenge (e.g., sends ambulances via a congested route without addressing it, relies on a hospital at capacity without alternatives), set consistent: false with an in-world consequence describing the operational disruption. If the player addresses the challenge (e.g., deploys traffic marshals, chooses alternate route, requests additional capacity), that is acceptable.",
  );
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
 *  - Facility environmental challenges (traffic, capacity, outages)
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

    // Load sector standards / team doctrines (with fuzzy name matching)
    let sectorStandards: string | undefined;
    if (teamName) {
      const teamDoctrines = insiderKnowledge.team_doctrines as
        | Record<string, unknown[]>
        | undefined;
      if (teamDoctrines) {
        const { standardsToPromptBlock } = await import('./warroomResearchService.js');
        const findings = resolveTeamDoctrines(teamDoctrines, teamName);
        if (findings.length > 0) {
          sectorStandards = standardsToPromptBlock(
            findings as import('./warroomResearchService.js').StandardsFinding[],
          );
        }
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

    const [infrastructureBlock, casualtyBlock, hazardSafetyBlock, facilityChallengesBlock] =
      await Promise.all([
        buildInfrastructureContext(sessionId, teamName),
        buildCasualtyContext(sessionId),
        buildHazardSafetyContext(sessionId),
        buildFacilityChallengesContext(sessionId),
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
- Medical Triage: named triage zones/areas, triage protocol (e.g. START, SALT, Triage Sieve), staff-to-patient ratios, casualty categorisation zones (Red/Yellow/Green), transport priorities and destination hospitals
- Media & Communications: evaluate based on the TYPE of media decision:
  • PUBLIC STATEMENT / PRESS RELEASE: Must contain specific, accurate content — incident details, verified numbers (casualty count, evacuee count, hazard status), named locations, actions being taken, and timeline. A statement with accurate figures and clear facts IS specific even without naming a spokesperson or press location (those are foundational setup items, not per-statement requirements). Set specific: true if the statement contains verifiable facts. If the trigger inject involves misinformation or unauthorized media, and the statement does NOT address/rebut the specific misinformation, set consistent: true but use mismatch_kind: "below_standard" with a MILD consequence about lingering public confusion — do NOT reject the entire statement.
  • MEDIA INFRASTRUCTURE SETUP (designating spokesperson, establishing media staging area, setting update cadence): Must name WHO the spokesperson is (by role), WHERE the media area is (coordinates or location name), and WHAT the update cadence is.
  • SPOKESPERSON ASSIGNMENT: When the decision designates a spokesperson, evaluate BOTH the choice AND the reasoning. The player must explain WHY this person is suited — authority level matching the severity, crisis-communication training, calm demeanor, public credibility, and cultural appropriateness for the community. A spokesperson who is too junior for a mass-casualty event, visibly distressed, or unfamiliar with the incident details should be flagged as mismatch_kind "below_standard". Appointing someone with no justification at all = set specific: false with missing_details ["spokesperson justification", "why this person is suited"].
  • CAMERA / BROADCAST POSITIONING: Evaluate whether the chosen camera angle and position protects victim dignity (no identifiable casualties in frame), avoids revealing tactical positions or security details, and projects a controlled professional response. Showing triage areas, body recovery, or tactical deployments on camera = mismatch_kind "below_standard" (severity "high" if victims are identifiable). A good camera position shows the response perimeter, spokesperson at a podium/staging area, and emergency vehicles — conveying competence without compromising operations or dignity.
  • MISINFORMATION RESPONSE: Must specifically name the false claim being rebutted and provide the correct information to counter it. Generic "we deny rumours" without specifics = not specific.
  • COORDINATION WITH OTHER TEAMS: Must state what information is being requested/shared and from/to which team. General "coordinate with teams" = not specific.
  Do NOT require spokesperson names, press conference locations, or update frequencies on EVERY media decision — these are foundational items established once, not repeated in every statement.
- Hazard Response: specific equipment type and class (e.g. "ABC dry chemical extinguisher" not just "water"), trained personnel to deploy it, approach method (upwind, from safe distance, etc.), safety perimeter, containment procedure, whether external services (fire brigade, HAZMAT) need to be called
- Bomb Squad / EOD (suspicious package / explosive device response):
  CRITICAL FAILURES (set consistent: false, severity: "high", mismatch_kind: "contradiction"):
  • Manual approach without robot assessment first
  • Using standard water disruptor on a METALLIC container (fragmentation risk — requires hard target disruptor)
  • Moving/transporting an unstable device manually without TCV
  • No exclusion zone established before attempting render safe procedure
  • Allowing radio/cell use within exclusion zone (RF detonation risk)
  
  BELOW STANDARD (consistent: false, severity: "medium", mismatch_kind: "below_standard"):
  • Exclusion zone radius smaller than the device's correct_standoff_m
  • No X-ray before RSP attempt
  • No coordination with nearby teams to evacuate their operational area within exclusion zone
  • Blow-in-place near a sensitive structure when transport via TCV was viable
  
  MEETS STANDARD (consistent: true, specific: true):
  • Correct exclusion zone for container type (matching correct_standoff_m/ft)
  • Robot deployed before any human approach
  • Correct disruptor type selected for container material
  • Comms blackout ordered within exclusion zone
  • Nearby teams warned and operations relocated if within exclusion radius
  • Evidence preserved post-RSP
  
  EXCEEDS STANDARD: All above + K9 sweep of surrounding area + forensic evidence catalogued + timely all-clear allowing operations to resume

  RSP SELECTION GUIDE (use to evaluate correctness):
  • Soft containers (backpack, cardboard, fabric): Standard Water Cannon / Water Disruption
  • Semi-rigid (plastic cooler): Standard Water Cannon acceptable
  • Metallic (briefcase, pipe, pressure cooker, toolbox): Hard Target Disruptor ONLY
  • Vehicle-borne: Vehicle-rated Standoff Disruptor
  • Sealed/unstable: Controlled Detonation (blow-in-place) or TCV transport

Set "specific": false when the decision gives general/vague instructions without naming concrete details. Set "specific": true when the decision names enough specifics to be executed without further clarification.

CRITICAL RULE: For vague operational decisions, describe the IN-WORLD CONSEQUENCE of unclear orders — do NOT tell the player what they should do. EXCEPTION: For infrastructure setup decisions (establishing command posts, triage areas, cordons, etc.), feedback can be constructive and acknowledge good intent when the decision includes coordinates, personnel, and equipment details.

When "specific" is false, the "feedback" MUST be an in-world consequence narrative matching the ESCALATION LEVEL:
- ESCALATION 0: minor friction from unclear orders. E.g. "Field teams are attempting to fight the fire with water from restroom buckets. The flames are intensifying — the improvised approach is having no effect and smoke is filling the corridor." Use the scenario's actual details.
- ESCALATION 1: significant in-world problem. E.g. "The fire has spread to adjacent areas while personnel attempted improvised suppression without proper equipment. Smoke inhalation cases are being reported among nearby evacuees."
- ESCALATION 2+: critical in-world damage. E.g. "The uncontrolled fire has engulfed the east wing. Multiple burn casualties are being reported. Structural integrity is compromised and emergency evacuation of the building has been triggered."

When "specific" is false:
- "missing_details": array of 2-5 short phrases (internal use only, NOT shown to player).
- "feedback": one paragraph (2-4 sentences) — in-world consequence narrative. Reference the actual scenario — do NOT be generic.
- "consequence_title": short (3-8 word) in-world field report headline.

=== INFRASTRUCTURE READINESS ===
When "TEAM INFRASTRUCTURE STATUS" is provided, evaluate infrastructure ONLY in these cases:
A) The decision is about ESTABLISHING infrastructure → evaluate positively (rules 3-5 below).
B) The decision involves TRANSPORT / TRANSFER / HANDOVER of a patient → check destination exists (TRANSPORT DESTINATION CHECK below).

⚠️ Do NOT flag infrastructure gaps when the decision is about on-scene rescue, triage assessment, treatment, or stabilization. A responder treating a patient in the field does NOT need a triage tent to administer first aid, initiate triage, or stabilize the patient. Infrastructure gaps ONLY matter when the decision says the patient will be MOVED to a facility.

1. CRITICAL GAP (ONLY for TRANSPORT/HANDOVER decisions): The decision orders transport or handover to a facility NOT deployed on the map. Set consistent: false, mismatch_kind "infrastructure_gap".
2. CROSS-TEAM GAP: Same, but another team's infrastructure is missing (e.g., decon zone).
3. PLANNING / ESTABLISHMENT EXCEPTION (apply BEFORE rules 1-2): Decision uses verbs like "establish", "set up", "deploy", "place", "create" for infrastructure → decision IS creating the infrastructure. Evaluate POSITIVELY.
   - With coordinates + personnel + equipment: consistent: true, specific: true.
   - With partial details: consistent: true, specific: true, constructive feedback.
   - Extremely vague (no location/personnel/equipment): specific: false.
4. SETUP WITH COORDINATES: Infrastructure + explicit coordinates = HIGH-QUALITY. Set consistent: true, specific: true.
5. SETUP WITHOUT COORDINATES: Infrastructure at named location but no coordinates → consistent: true, specific: false, constructive guidance.

TRANSPORT DESTINATION CHECK (ONLY when decision describes transport/transfer/handover):
- Names a facility that EXISTS in infrastructure list → consistent: true. Note capacity if listed.
- Names a facility that does NOT exist → consistent: false, mismatch_kind: "infrastructure_gap", describe patient arriving at non-existent location.
- Orders transport but does NOT name a destination AND facilities exist → consistent: true, feedback: "No specific destination was named in the transport order. The patient was routed to [closest facility from infrastructure list] by default. Naming a specific facility improves handover efficiency."
- Orders transport but NO medical facilities exist at all → consistent: false, mismatch_kind: "infrastructure_gap", reason: "The patient has been packaged for transport but there is no triage tent, field hospital, or casualty collection point deployed on the map. The stretcher team is standing by with nowhere to deliver the patient."

When mismatch_kind is "infrastructure_gap":
- reason: in-world consequence of acting without proper infrastructure. Match the ESCALATION LEVEL.
- consequence_title: short (3-8 word) in-world headline.
- severity: "medium" for partial gaps, "high" for critical missing infrastructure that endangers lives.

=== CASUALTY TREATMENT EVALUATION ===
When "ACTIVE CASUALTIES IN SCENE" is provided, evaluate the decision in this STRICT PRIORITY ORDER:

STEP 1 — RESCUE QUALITY (evaluate FIRST — this determines if the patient can be helped):
Did the responder deploy the RIGHT personnel and RIGHT equipment for the patient's condition?
- Personnel qualified for the task? (paramedics for medical care, firefighters for extraction from debris/fire)
- Equipment appropriate? (stretcher for immobile patient, burn dressings for burns, splint for fractures, tourniquet for hemorrhage)
- Personnel count sufficient? (2 bearers minimum for stretcher carry, adequate medic-to-patient ratio)
- PPE appropriate for the zone? (SCBA in hot zone, gloves for patient contact, face shields for fluid risk)
If rescue quality is adequate → set consistent: true. The patient CAN be treated on-scene even without nearby infrastructure.
If rescue quality is poor → set consistent: false, mismatch_kind "below_standard", describe the in-world consequence (e.g., "the single responder is struggling to move the patient without a stretcher").

STEP 2 — TREATMENT ADEQUACY:
1. INADEQUATE TREATMENT: Critical interventions skipped:
   - Transporting a fracture without splinting (vascular/nerve damage risk)
   - Moving a patient without controlling active bleeding (hemorrhagic shock)
   - No airway management for labored/absent breathing
   - No burn dressings or fluid resuscitation for burn patients
   Set consistent: false, mismatch_kind "below_standard". Severity based on risk.

2. DANGEROUS TREATMENT: Contraindicated actions:
   - Tourniquet on crush injury without medical oversight (reperfusion syndrome)
   - Moving spinal injury without immobilization
   - Giving fluids to suspected internal injuries without medical authority
   Set consistent: false, mismatch_kind "contradiction", severity "high".

3. ADEQUATE: Appropriate care for the patient's injuries. No penalty.

STEP 3 — TRANSPORT DESTINATION (evaluate ONLY IF the decision explicitly says "transport", "transfer", "handover", or "move patient to"):
Apply the TRANSPORT DESTINATION CHECK rules from INFRASTRUCTURE READINESS above.
⚠️ Do NOT check for infrastructure if the decision is about on-scene treatment, stabilization, or triage without mentioning transport. A medic triaging a patient in the warm zone does NOT need a triage tent to do their job.

4. RESOURCE MISALLOCATION — BLACK PATIENTS:
   If the decision allocates treatment resources (ambulances, stretchers, medical personnel, ongoing treatment) to a BLACK-tagged patient while ANY RED or YELLOW patients remain untreated/awaiting care:
   - Set consistent: false, mismatch_kind "below_standard", severity "high".
   - Message: "Resources allocated to deceased patient while [count] surviving patients with [RED/YELLOW] priority still await care. Triage protocol requires prioritizing the living."
   BLACK patients should only receive: tag confirmation, cover, location documentation, coroner notification. Any action beyond that is flagged when survivors remain.
   Exception: If ALL RED and YELLOW patients have been treated/transported, extended care for BLACK patients is acceptable.

5. RELEVANCE: Only evaluate when the decision DIRECTLY involves patient care, treatment, or transport. Do not evaluate infrastructure setup, command, or communication decisions against casualty data.

When treatment_requirements or transport_prerequisites are listed for a patient, use them as ground truth. When ideal_response_sequence is provided, use it as the benchmark for a perfect response — check if the player's actions follow the correct order and include all critical steps. When required_ppe is listed, the decision MUST mention appropriate PPE or it is a specificity failure. When required_equipment is listed, the decision MUST name the specific equipment or it is a specificity failure. When they are absent, infer required care from the injury data using standard pre-hospital protocols (PHTLS, ITLS, TCCC).
When recommended_transport is listed for a patient, score the transport destination against it — sending a burns patient to a hospital without a burns unit, or a spinal injury to a facility without a spine unit, is below_standard. The recommended hospital reflects the best match for the patient's specific injuries and nearby hospital capabilities. When deterioration_timeline is listed, use it to assess time-sensitivity — if the team delayed treatment beyond a critical deterioration milestone (e.g. patient needed airway management within 10 minutes but team took 25 minutes), note the real-world consequence from the timeline as in-world feedback.

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

D. PATIENT HANDOFF CHAIN (CRITICAL — check for EVERY casualty decision):
Look at the ZONE where the patient is located (shown in ACTIVE CASUALTIES as "ZONE: HOT/WARM/COLD").

HOT ZONE patients — EXTRACTION ONLY:
- If the decision describes full triage (START/SALT assessment, triage tagging), IV access, fluid resuscitation, wound care, splinting, monitoring vitals, or any treatment beyond immediate life-saving: set consistent: false, mismatch_kind "below_standard", severity "high".
  Consequence: "The responder is attempting to perform [specific treatment] on a patient still inside the hot zone. This delays extraction, exposes the responder to prolonged hazard contact, and the patient's condition continues to deteriorate from environmental threats. The patient must be extracted to the warm zone before treatment can begin."
- ALLOWED in hot zone: DRABC rapid assessment, tourniquet/direct pressure for life-threatening hemorrhage, basic airway management, rapid extrication, packaging onto stretcher, and transport to warm zone. These are acceptable and should NOT be penalized.
- If the decision says "transport to warm zone" or "extract to warm zone" — this is CORRECT. No penalty.

WARM ZONE patients — TRIAGE & STABILIZATION:
- Full triage, IV access, splinting, wound packing, monitoring, and stabilization are all ALLOWED.
- Definitive surgical care or prolonged hospital-level treatment should be flagged as below_standard — the patient should be moved to a cold zone facility.
- If the decision says "transport to triage tent / field hospital / cold zone" — CORRECT. Check destination exists (TRANSPORT DESTINATION CHECK).

COLD ZONE patients — FULL TREATMENT:
- All treatment levels allowed. Check for treatment quality and transport to hospital when needed.

SKIPPING ZONES:
- Moving a patient from hot zone directly to cold zone, skipping warm zone stabilization/decon: below_standard — "patient requires stabilization in the warm zone before transfer to definitive care."
- Moving a patient from hot zone directly to hospital, skipping all field treatment: below_standard — "patient has not been stabilized or triaged before hospital transport."
- Proper chain followed (extricate from hot → stabilize in warm → treat in cold → hospital): no penalty.

ESCALATING CONSEQUENCES (no hard blocks):
- Wrong zone + wrong team + no PPE = "contradiction" + severe narrative (injuries, team member down)
- Wrong zone + right team + partial PPE = "below_standard" + moderate consequence
- No zones established + actions proceeding = "below_standard" + "operating without scene assessment"
- Correct zone protocol followed = consistent: true

RELEVANCE: Only evaluate zone safety when decisions involve deploying people near active hazards OR when hazard zone data shows personnel in zones. Decisions about infrastructure setup in the cold zone or away from hazards should NOT be penalized for zone issues.

=== SAFETY GUARDRAILS ===
FORBIDDEN ACTIONS (set "rejected": true with "rejection_reason"):
- Non-EOD teams directly handling, detonating, disarming, or triggering explosive devices (Bomb Squad / EOD teams ARE authorized to perform render-safe procedures via robot or approved RSP methods)
- Intentionally causing harm to people
- Ordering emergency services to stand down without authorisation
- Deliberately endangering civilians
- Impersonating emergency services

Contacting or requesting bomb disposal teams, EOD, SPF, or SCDF is ALLOWED. Bomb Squad / EOD teams performing render-safe procedures (water disruption, hard target disruption, controlled detonation, TCV transport) via robot are ALLOWED and should be evaluated using the EOD evaluation criteria above.

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

    const userPrompt = `${hazardStandardsBlock}${sectorStandardsLine}${teamRoleLine}${escalationLine}${infrastructureBlock}${casualtyBlock}${hazardSafetyBlock}${facilityChallengesBlock}${incidentUserBlock}DECISION:
Title: ${decision.title}
Description: ${decision.description}

Evaluate this decision against professional response standards, operational specificity, infrastructure readiness, casualty treatment adequacy, personnel safety, and facility environmental challenges. ALL "reason" and "feedback" text must be IN-WORLD CONSEQUENCES only — describe what is happening on the ground as a result of the decision. NEVER tell the player what is wrong, what they should do, or what is missing.

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
