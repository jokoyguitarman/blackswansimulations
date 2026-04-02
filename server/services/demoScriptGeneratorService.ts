import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import type { DemoScript } from './demoScriptPlaybackService.js';

const SCRIPTS_DIR = join(process.cwd(), 'demo_scripts');
const AI_MODEL = 'gpt-4o-mini';

/**
 * Generates a full demo script JSON from an existing scenario's data via OpenAI.
 *
 * Reads: scenario, teams, time-bound injects, locations, insider_knowledge
 * (sector_standards + team_doctrines) and asks the model to produce a realistic
 * sequence of decisions, placements, and chat messages.
 */
export async function generateDemoScript(
  scenarioId: string,
  options?: { durationMinutes?: number; eventDensity?: 'light' | 'normal' | 'heavy' },
): Promise<{ script: DemoScript; filePath: string } | null> {
  if (!env.openAiApiKey) {
    logger.error('Script generator requires OPENAI_API_KEY');
    return null;
  }

  const ctx = await loadFullScenarioContext(scenarioId);
  if (!ctx) {
    logger.error({ scenarioId }, 'Script generator: failed to load scenario context');
    return null;
  }

  const duration = options?.durationMinutes ?? ctx.estimatedDuration ?? 14;
  const density = options?.eventDensity ?? 'normal';
  const densityCounts: Record<string, string> = {
    light: '25-35',
    normal: '40-55',
    heavy: '60-80',
  };

  const systemPrompt = buildGeneratorSystemPrompt();
  const userPrompt = buildGeneratorUserPrompt(ctx, duration, densityCounts[density]);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.75,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, 'Script generator: OpenAI call failed');
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    const script = JSON.parse(content) as DemoScript;

    if (!script.events || !Array.isArray(script.events)) {
      logger.error('Script generator: invalid script – missing events array');
      return null;
    }

    script.name = script.name || `${ctx.title} – Generated Demo`;
    script.scenarioType = script.scenarioType || ctx.scenarioType;
    script.durationMinutes = duration;
    script.coordinateOffsets = true;

    if (!existsSync(SCRIPTS_DIR)) {
      mkdirSync(SCRIPTS_DIR, { recursive: true });
    }

    const slug = ctx.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    const fileName = `${slug}_generated_${Date.now()}.json`;
    const filePath = join(SCRIPTS_DIR, fileName);

    writeFileSync(filePath, JSON.stringify(script, null, 2), 'utf-8');

    logger.info(
      { scenarioId, fileName, eventCount: script.events.length },
      'Script generator: demo script created',
    );

    return { script, filePath };
  } catch (err) {
    logger.error({ error: err, scenarioId }, 'Script generator: unexpected error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context Loader
// ---------------------------------------------------------------------------

interface ScenarioContext {
  title: string;
  description: string;
  scenarioType: string;
  centerLat: number | null;
  centerLng: number | null;
  teams: Array<{ team_name: string; description: string; role_name: string; agency_name: string }>;
  injects: Array<{
    title: string;
    inject_text: string;
    scheduled_offset_minutes: number | null;
    target_team: string | null;
  }>;
  locations: Array<{ name: string; type: string; description: string }>;
  sectorStandards: string;
  teamDoctrines: Record<string, unknown>;
  estimatedDuration: number;
}

async function loadFullScenarioContext(scenarioId: string): Promise<ScenarioContext | null> {
  try {
    const { data: scenario } = await supabaseAdmin
      .from('scenarios')
      .select('id, title, description, scenario_type, center_lat, center_lng')
      .eq('id', scenarioId)
      .single();

    if (!scenario) return null;

    const { data: teams } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name, description, role_name, agency_name')
      .eq('scenario_id', scenarioId);

    const { data: injects } = await supabaseAdmin
      .from('scenario_injects')
      .select('title, inject_text, scheduled_offset_minutes, target_team')
      .eq('scenario_id', scenarioId)
      .not('scheduled_offset_minutes', 'is', null)
      .order('scheduled_offset_minutes', { ascending: true })
      .limit(30);

    const { data: locations } = await supabaseAdmin
      .from('scenario_locations')
      .select('name, type, description')
      .eq('scenario_id', scenarioId)
      .limit(15);

    const { data: insiderKnowledge } = await supabaseAdmin
      .from('insider_knowledge')
      .select('sector_standards, team_doctrines')
      .eq('scenario_id', scenarioId)
      .maybeSingle();

    const ik = insiderKnowledge as Record<string, unknown> | null;

    const maxInjectOffset = (injects ?? []).reduce((max, i) => {
      const offset = (i as Record<string, unknown>).scheduled_offset_minutes as number | null;
      return offset != null && offset > max ? offset : max;
    }, 0);
    const estimatedDuration = Math.max(maxInjectOffset + 3, 10);

    return {
      title: (scenario as Record<string, unknown>).title as string,
      description: ((scenario as Record<string, unknown>).description as string) || '',
      scenarioType: ((scenario as Record<string, unknown>).scenario_type as string) || 'general',
      centerLat: (scenario as Record<string, unknown>).center_lat as number | null,
      centerLng: (scenario as Record<string, unknown>).center_lng as number | null,
      teams: ((teams ?? []) as Array<Record<string, unknown>>).map((t) => ({
        team_name: (t.team_name as string) || '',
        description: (t.description as string) || '',
        role_name: (t.role_name as string) || '',
        agency_name: (t.agency_name as string) || '',
      })),
      injects: ((injects ?? []) as Array<Record<string, unknown>>).map((i) => ({
        title: (i.title as string) || '',
        inject_text: (i.inject_text as string) || '',
        scheduled_offset_minutes: i.scheduled_offset_minutes as number | null,
        target_team: (i.target_team as string) || null,
      })),
      locations: ((locations ?? []) as Array<Record<string, unknown>>).map((l) => ({
        name: (l.name as string) || '',
        type: (l.type as string) || '',
        description: (l.description as string) || '',
      })),
      sectorStandards: (ik?.sector_standards as string) || '',
      teamDoctrines: (ik?.team_doctrines as Record<string, unknown>) || {},
      estimatedDuration,
    };
  } catch (err) {
    logger.error({ error: err, scenarioId }, 'Script generator: context load error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

function buildGeneratorSystemPrompt(): string {
  return `You are an expert crisis-management exercise scriptwriter. You produce realistic, tactical demo scripts for a multi-agency war-room simulation platform.

Your output MUST be a single JSON object matching this schema:

{
  "name": "Script display name",
  "scenarioType": "e.g. active_shooter",
  "durationMinutes": 14,
  "coordinateOffsets": true,
  "events": [
    {
      "offsetMinutes": 0.5,
      "team": "team_name from scenario",
      "type": "decision" | "placement" | "chat",
      "payload": { ... }
    }
  ]
}

## Event payload schemas

### decision
{ "title": "...", "description": "...", "decision_type": "containment|tactical_deployment|resource_request|communication|medical_response|evacuation|investigation|public_information|negotiation|hazmat_response" }

### placement
{ "asset_type": "command_post|inner_cordon|outer_cordon|staging_area|triage_point|evacuation_route|sniper_position|tactical_unit|press_cordon|decontamination_zone|helicopter_lz|roadblock|observation_post|casualty_collection|forward_command|water_point|rest_area", "label": "...", "geometry": { "type": "Point|LineString|Polygon", "coordinates": [...] } }
Coordinates MUST be small offsets from [0,0] (e.g. [0.001, -0.002]). The engine translates them to the scenario center.
Points: [lng, lat]. LineStrings: [[lng,lat],...]. Polygons: [[[lng,lat],...]].

### chat
{ "content": "short professional radio-style message" }

## Rules
- Events MUST be sorted by offsetMinutes ascending.
- Spread events across ALL teams, not just one.
- Start with initial assessment and command post setup, then containment, then specialist deployments, then resolution phases.
- Include a mix of all three event types — roughly 40% decisions, 30% placements, 30% chat.
- React to the scenario's pre-scheduled injects: after an inject fires, the relevant teams should respond.
- Follow the provided sector standards and team doctrines.
- Make decisions specific and tactically sound — avoid generic language.
- Return ONLY the JSON object. No markdown fences.`;
}

function buildGeneratorUserPrompt(
  ctx: ScenarioContext,
  duration: number,
  eventCount: string,
): string {
  const parts: string[] = [];

  parts.push(
    `Generate a ${duration}-minute demo script with approximately ${eventCount} events for this scenario:`,
  );
  parts.push('');
  parts.push(`## Scenario: ${ctx.title}`);
  parts.push(`Type: ${ctx.scenarioType}`);
  if (ctx.description) parts.push(`Description: ${ctx.description}`);

  parts.push('');
  parts.push('## Teams');
  for (const team of ctx.teams) {
    parts.push(
      `- **${team.team_name}** (${team.role_name}, ${team.agency_name}): ${team.description}`,
    );
  }

  if (ctx.locations.length > 0) {
    parts.push('');
    parts.push('## Key Locations');
    for (const loc of ctx.locations) {
      parts.push(`- ${loc.name} (${loc.type}): ${loc.description}`);
    }
  }

  if (ctx.injects.length > 0) {
    parts.push('');
    parts.push('## Pre-Scheduled Injects (teams must react to these)');
    for (const inj of ctx.injects) {
      const target = inj.target_team ? ` [${inj.target_team}]` : '';
      parts.push(
        `- @${inj.scheduled_offset_minutes ?? '?'}min${target}: ${inj.title} — ${inj.inject_text.slice(0, 200)}`,
      );
    }
  }

  if (ctx.sectorStandards) {
    parts.push('');
    parts.push('## Sector Standards');
    parts.push(ctx.sectorStandards.slice(0, 2000));
  }

  if (Object.keys(ctx.teamDoctrines).length > 0) {
    parts.push('');
    parts.push('## Team Doctrines');
    for (const [teamName, doctrines] of Object.entries(ctx.teamDoctrines)) {
      const entries = doctrines as Array<{ title?: string; summary?: string }>;
      if (Array.isArray(entries)) {
        parts.push(`### ${teamName}`);
        for (const d of entries.slice(0, 5)) {
          parts.push(`- ${d.title || ''}: ${d.summary || ''}`);
        }
      }
    }
  }

  parts.push('');
  parts.push(
    `Use team names exactly as listed above in the "team" field. Generate ${eventCount} events spread across the full ${duration} minutes.`,
  );

  return parts.join('\n');
}
