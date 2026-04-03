import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  getWebSocketService,
  type WebSocketEvent,
  type InternalEventHandler,
} from './websocketService.js';
import { DemoActionDispatcher, resolveBotUserId } from './demoActionDispatcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIDifficultyLevel = 'novice' | 'intermediate' | 'advanced';

interface AgentPersona {
  botUserId: string;
  teamName: string;
  fullName: string;
  roleName: string;
  agencyName: string;
  teamDescription: string;
  doctrines: string;
}

interface AgentState {
  persona: AgentPersona;
  recentActions: string[];
  lastActionTs: number;
  pendingCooldown: boolean;
  actedThisCycle: boolean;
}

interface SessionAgents {
  sessionId: string;
  scenarioId: string;
  scenarioSummary: string;
  sectorStandards: string;
  incidentCenter: { lat: number; lng: number } | null;
  startedAt: number;
  agents: Map<string, AgentState>;
  channelId: string | null;
  eventHandler: InternalEventHandler;
  channelHandlers: Map<string, InternalEventHandler>;
  proactiveTimer: ReturnType<typeof setInterval> | null;
  scriptAware: boolean;
  scriptNextEventTs: number;
  stopped: boolean;
  cycleDecisionCount: number;
  lastInjectTs: number;
  difficulty: AIDifficultyLevel;
}

interface SingleAction {
  action: 'decision' | 'placement' | 'chat' | 'claim' | 'pin_response' | 'none';
  decision?: { title: string; description: string };
  placement?: {
    asset_type: string;
    label: string;
    geometry: { type: string; coordinates: unknown };
    properties?: Record<string, unknown>;
  };
  chat?: { content: string };
  claim?: {
    location_label: string;
    claimed_as: string;
    exclusivity?: string;
  };
  pin_response?: {
    target_id: string;
    target_type: 'casualty' | 'hazard';
    target_label: string;
    actions: string[];
    resources: Array<{ type: string; label: string; quantity: number }>;
    triage_color?: 'green' | 'yellow' | 'red' | 'black';
    description: string;
  };
}

interface AgentMultiResponse {
  actions: SingleAction[];
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Constants — tuned for realistic human-like pacing
// ---------------------------------------------------------------------------

const AGENT_THROTTLE_MS = 180_000; // 3 min cooldown per agent after acting
const AGENT_THROTTLE_EARLY_MS = 90_000; // 90s cooldown during foundational phase (first 8 min)
const FOUNDATIONAL_PHASE_MINUTES = 8; // first N minutes: reduced throttle, higher proactive rate
const AGENT_JITTER_BASE_MS = 15_000;
const AGENT_JITTER_RANGE_MS = 20_000;
const INTER_ACTION_BASE_MS = 5_000;
const INTER_ACTION_RANGE_MS = 5_000;
const HYBRID_DEFER_WINDOW_MS = 10_000;
const MAX_RECENT_ACTIONS = 15;
const AI_MODEL = 'gpt-4o-mini';
const PROACTIVE_INTERVAL_MS = 180_000; // 3 min between proactive ticks
const PROACTIVE_ACT_PROBABILITY = 0.2; // 20% chance per agent per tick
const PROACTIVE_ACT_PROBABILITY_EARLY = 0.4; // 40% during foundational phase
const KICKSTART_STAGGER_MS = 20_000; // 20s between kickstart agents
const KICKSTART_INITIAL_DELAY_MS = 12_000;
const MAX_DECISIONS_PER_INJECT_CYCLE = 5; // max decisions across ALL agents before waiting for next inject
const INJECT_CYCLE_RESET_MS = 120_000; // auto-reset cycle budget after 2 min

// ---------------------------------------------------------------------------
// Hardcoded team scope — what each team is allowed to place / respond to.
// Keys are matched via .includes() against the lowercased team name.
// ---------------------------------------------------------------------------

const TEAM_ALLOWED_PLACEMENTS: Record<string, Set<string>> = {
  police: new Set([
    'command_post',
    'inner_cordon',
    'outer_cordon',
    'roadblock',
    'observation_post',
    'hot_zone',
    'warm_zone',
    'cold_zone',
    'staging_area',
    'forward_command',
  ]),
  security: new Set([
    'command_post',
    'inner_cordon',
    'outer_cordon',
    'roadblock',
    'observation_post',
    'hot_zone',
    'warm_zone',
    'cold_zone',
    'staging_area',
  ]),
  fire: new Set([
    'fire_truck',
    'water_supply',
    'forward_command',
    'hot_zone',
    'warm_zone',
    'decontamination_zone',
    'staging_area',
    'command_post',
  ]),
  hazmat: new Set([
    'fire_truck',
    'water_supply',
    'forward_command',
    'hot_zone',
    'warm_zone',
    'decontamination_zone',
    'staging_area',
    'command_post',
    'exclusion_zone',
  ]),
  triage: new Set([
    'triage_point',
    'field_hospital',
    'casualty_collection',
    'ambulance_staging',
    'helicopter_lz',
    'command_post',
    'inner_cordon',
  ]),
  medical: new Set([
    'triage_point',
    'field_hospital',
    'casualty_collection',
    'ambulance_staging',
    'helicopter_lz',
    'command_post',
    'inner_cordon',
  ]),
  ems: new Set([
    'triage_point',
    'field_hospital',
    'casualty_collection',
    'ambulance_staging',
    'helicopter_lz',
  ]),
  evacuation: new Set(['assembly_point', 'staging_area', 'marshal_post', 'command_post']),
  media: new Set(['press_cordon', 'media_staging']),
};

const TEAM_ALLOWED_PIN_TYPES: Record<string, Set<string>> = {
  triage: new Set(['casualty']),
  medical: new Set(['casualty']),
  ems: new Set(['casualty']),
  ambulance: new Set(['casualty']),
  fire: new Set(['hazard', 'casualty']),
  hazmat: new Set(['hazard', 'casualty']),
  evacuation: new Set(['crowd']),
};

const EXTRACT_ONLY_TEAMS = new Set(['fire', 'hazmat']);

// Per-team required infrastructure that MUST be placed before pin_response is allowed.
// Once ALL required assets exist in placed_assets, the team is "operational".
const TEAM_REQUIRED_INFRASTRUCTURE: Record<string, string[]> = {
  police: ['outer_cordon', 'roadblock'],
  security: ['outer_cordon', 'roadblock'],
  fire: ['forward_command', 'staging_area'],
  hazmat: ['forward_command', 'staging_area'],
  triage: ['triage_point', 'inner_cordon'],
  medical: ['triage_point', 'inner_cordon'],
  ems: ['triage_point'],
  evacuation: ['assembly_point'],
  media: ['press_cordon', 'media_staging'],
};

// Inject keyword domains — if an inject's title/description contains these keywords,
// only the listed team keys should react. Teams not listed ignore the inject.
const INJECT_DOMAIN_KEYWORDS: Array<{ patterns: RegExp; teams: string[] }> = [
  {
    patterns: /media|press|journalist|reporter|camera|microphone|footage|interview|broadcast/i,
    teams: ['media'],
  },
  {
    patterns: /casualt|patient|injur|wound|bleed|triage|medical|ambulance|stretcher/i,
    teams: ['triage', 'medical', 'ems', 'fire', 'hazmat'],
  },
  {
    patterns: /fire|blaze|smoke|flame|burn|hazmat|chemical|spill|toxic|gas|explosion/i,
    teams: ['fire', 'hazmat'],
  },
  {
    patterns: /crowd|panic|stampede|evacuat|assembly|shelter|civilian/i,
    teams: ['evacuation', 'police', 'security'],
  },
  {
    patterns: /cordon|perimete|barricade|roadblock|checkpoint|secur|breach|intrud/i,
    teams: ['police', 'security'],
  },
  {
    patterns: /sighting|suspect|adversary|pursuit|fugitive|shooter|armed|weapon/i,
    teams: ['police', 'security', 'intelligence'],
  },
  { patterns: /negotiate|hostage|demand|surrender/i, teams: ['negotiation', 'police'] },
];

function getTeamScopeKey(teamName: string): string | null {
  const t = teamName.toLowerCase();
  const keys = Object.keys(TEAM_ALLOWED_PLACEMENTS);
  for (const k of keys) {
    if (t.includes(k)) return k;
  }
  return null;
}

function isPlacementAllowedForTeam(teamName: string, assetType: string): boolean {
  const key = getTeamScopeKey(teamName);
  if (!key) return true;
  return TEAM_ALLOWED_PLACEMENTS[key].has(assetType);
}

function getRequiredInfrastructure(teamName: string): string[] {
  const key = getTeamScopeKey(teamName);
  if (!key) return [];
  return TEAM_REQUIRED_INFRASTRUCTURE[key] ?? [];
}

function isInjectRelevantToTeam(
  teamName: string,
  injectTitle: string,
  injectDescription: string,
): boolean {
  const text = `${injectTitle} ${injectDescription}`;
  const teamKey = getTeamScopeKey(teamName);
  if (!teamKey) return true;

  for (const { patterns, teams } of INJECT_DOMAIN_KEYWORDS) {
    if (patterns.test(text)) {
      return teams.includes(teamKey);
    }
  }
  // No domain keywords matched — universal inject, all teams react
  return true;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DemoAIAgentService {
  private sessions = new Map<string, SessionAgents>();
  private dispatcher = new DemoActionDispatcher();

  async start(
    sessionId: string,
    scenarioId: string,
    options?: { scriptAware?: boolean; difficulty?: AIDifficultyLevel },
  ): Promise<boolean> {
    if (this.sessions.has(sessionId)) {
      logger.warn({ sessionId }, 'AI agents already running for session');
      return false;
    }

    if (!env.openAiApiKey) {
      logger.error({ sessionId }, 'AI agents require OPENAI_API_KEY');
      return false;
    }

    const context = await this.loadScenarioContext(scenarioId);
    if (!context) return false;

    const channelId = await this.dispatcher.getSessionChannelId(sessionId);
    const difficulty = options?.difficulty ?? 'intermediate';

    const session: SessionAgents = {
      sessionId,
      scenarioId,
      scenarioSummary: context.scenarioSummary,
      sectorStandards: context.sectorStandards,
      incidentCenter: context.incidentCenter,
      startedAt: Date.now(),
      agents: new Map(),
      channelId,
      eventHandler: () => {},
      channelHandlers: new Map(),
      proactiveTimer: null,
      scriptAware: options?.scriptAware ?? false,
      scriptNextEventTs: 0,
      stopped: false,
      cycleDecisionCount: 0,
      lastInjectTs: 0,
      difficulty,
    };

    for (const team of context.teams) {
      const botUserId = resolveBotUserId(team.team_name);
      const profile = await this.loadBotProfile(botUserId);

      session.agents.set(botUserId, {
        persona: {
          botUserId,
          teamName: team.team_name,
          fullName: profile?.full_name || team.team_name,
          roleName: profile?.role || team.team_name,
          agencyName: profile?.agency_name || team.team_name,
          teamDescription: team.description || '',
          doctrines: team.doctrines || '',
        },
        recentActions: [],
        lastActionTs: 0,
        pendingCooldown: false,
        actedThisCycle: false,
      });
    }

    const handler: InternalEventHandler = (event) => {
      if (session.stopped) return;
      this.handleSessionEvent(session, event).catch((err) => {
        logger.error({ error: err, sessionId, eventType: event.type }, 'AI agent event error');
      });
    };
    session.eventHandler = handler;
    getWebSocketService().onSessionEvent(sessionId, handler);

    if (channelId) {
      const chHandler: InternalEventHandler = (event) => {
        if (session.stopped) return;
        this.handleChannelEvent(session, event);
      };
      session.channelHandlers.set(channelId, chHandler);
      getWebSocketService().onChannelEvent(channelId, chHandler);
    }

    this.sessions.set(sessionId, session);
    logger.info({ sessionId, scenarioId, agentCount: session.agents.size }, 'AI agents started');

    this.runKickstart(session);

    session.proactiveTimer = setInterval(() => {
      if (session.stopped) return;
      this.proactiveTick(session).catch((err) => {
        logger.error({ error: err, sessionId }, 'AI agent proactive tick error');
      });
    }, PROACTIVE_INTERVAL_MS);

    return true;
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopped = true;
    getWebSocketService().offSessionEvent(sessionId, session.eventHandler);
    for (const [chId, handler] of session.channelHandlers) {
      getWebSocketService().offChannelEvent(chId, handler);
    }
    if (session.proactiveTimer) {
      clearInterval(session.proactiveTimer);
      session.proactiveTimer = null;
    }
    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'AI agents stopped');
  }

  notifyUpcomingScriptEvent(sessionId: string, firesAtMs: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.scriptNextEventTs = firesAtMs;
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Kickstart & Proactive loop
  // ---------------------------------------------------------------------------

  private runKickstart(session: SessionAgents): void {
    const agentEntries = Array.from(session.agents.entries());

    // ── PHASE 2: Infrastructure pass (place command posts, cordons, triage) ──
    const infraEvent: WebSocketEvent = {
      type: 'session.started',
      data: {
        message:
          'PHASE 2 — ESTABLISH INFRASTRUCTURE.\n' +
          'Exits have been claimed. Now establish your foundational infrastructure:\n' +
          '1. PLACE your COMMAND POST (point asset) at an appropriate staging location.\n' +
          '2. PLACE cordons, barricades, or perimeter assets your team is responsible for.\n' +
          '3. SET UP triage areas, evacuation holding points, or staging areas for your role.\n' +
          '4. Perform your initial SITUATION ASSESSMENT and communicate it to chat.\n' +
          'You MUST include at least ONE placement action. Describe coordinates precisely.',
      },
      timestamp: new Date().toISOString(),
    };

    session.cycleDecisionCount = 0;
    session.lastInjectTs = Date.now();

    // Phase 1: programmatic round-robin exit claiming (no AI involved)
    this.claimExitsRoundRobin(session, agentEntries).catch((err) => {
      logger.error({ error: err, sessionId: session.sessionId }, 'Kickstart exit claiming failed');
    });

    // Phase 2: all agents place infrastructure (staggered after claims finish)
    const phase2Start = KICKSTART_INITIAL_DELAY_MS + agentEntries.length * 5_000 + 15_000;

    for (let i = 0; i < agentEntries.length; i++) {
      const [, agentState] = agentEntries[i];
      const infraDelay = phase2Start + i * KICKSTART_STAGGER_MS + Math.random() * 5000;

      setTimeout(() => {
        if (session.stopped) return;
        agentState.lastActionTs = 0;
        agentState.actedThisCycle = false;
        this.generateAndExecuteActions(session, agentState, infraEvent).catch((err) => {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId },
            'AI agent kickstart infrastructure phase failed',
          );
        });
      }, infraDelay);
    }
  }

  private async proactiveTick(session: SessionAgents): Promise<void> {
    if (session.stopped) return;

    // Auto-reset cycle budget if enough time passed since last inject
    const now = Date.now();
    if (session.lastInjectTs > 0 && now - session.lastInjectTs > INJECT_CYCLE_RESET_MS) {
      session.cycleDecisionCount = 0;
      for (const [, a] of session.agents) {
        a.actedThisCycle = false;
      }
      session.lastInjectTs = now;
    }

    // If cycle budget already used up, skip entirely
    if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) return;

    const elapsed = this.getElapsedMinutes(session);

    const proactiveEvent: WebSocketEvent = {
      type: 'proactive.tick',
      data: {
        message: `${Math.floor(elapsed)} minutes into the exercise. Assess the current situation and take your next action if appropriate.`,
        elapsed_minutes: Math.floor(elapsed),
      },
      timestamp: new Date().toISOString(),
    };

    // Pick at most ONE agent to act per proactive tick
    const eligible = Array.from(session.agents.values()).filter(
      (a) => this.canAct(a, session) && !a.actedThisCycle,
    );
    if (eligible.length === 0) return;

    const isEarly = elapsed < FOUNDATIONAL_PHASE_MINUTES;
    const actProbability = isEarly ? PROACTIVE_ACT_PROBABILITY_EARLY : PROACTIVE_ACT_PROBABILITY;
    if (Math.random() > actProbability) return;

    const agent = eligible[Math.floor(Math.random() * eligible.length)];
    const jitter = AGENT_JITTER_BASE_MS + Math.random() * AGENT_JITTER_RANGE_MS;
    setTimeout(() => {
      if (session.stopped) return;
      if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) return;
      this.generateAndExecuteActions(session, agent, proactiveEvent).catch((err) => {
        logger.error(
          { error: err, botUserId: agent.persona.botUserId },
          'AI agent proactive action failed',
        );
      });
    }, jitter);
  }

  // ---------------------------------------------------------------------------
  // Scenario context loader
  // ---------------------------------------------------------------------------

  private async loadScenarioContext(scenarioId: string): Promise<{
    scenarioSummary: string;
    sectorStandards: string;
    incidentCenter: { lat: number; lng: number } | null;
    teams: Array<{ team_name: string; description: string; doctrines: string }>;
  } | null> {
    try {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('id, title, description, category, center_lat, center_lng, insider_knowledge')
        .eq('id', scenarioId)
        .single();

      if (!scenario) return null;

      const { data: teams } = await supabaseAdmin
        .from('scenario_teams')
        .select('team_name, team_description')
        .eq('scenario_id', scenarioId);

      const ik = (scenario as Record<string, unknown>).insider_knowledge as Record<
        string,
        unknown
      > | null;
      const sectorStandards = (ik?.sector_standards as string) || '';
      const teamDoctrines: Record<string, unknown> =
        (ik?.team_doctrines as Record<string, unknown>) || {};

      const { data: locations } = await supabaseAdmin
        .from('scenario_locations')
        .select('label, location_type, coordinates')
        .eq('scenario_id', scenarioId)
        .limit(15);

      let incidentCenter: { lat: number; lng: number } | null =
        scenario.center_lat != null && scenario.center_lng != null
          ? { lat: scenario.center_lat as number, lng: scenario.center_lng as number }
          : null;

      // Fallback: derive center from incident_site pin or first location with coords
      if (!incidentCenter && locations?.length) {
        const incidentPin = (locations as Array<Record<string, unknown>>).find((l) =>
          (l.location_type as string)?.includes('incident_site'),
        );
        const targetPin = incidentPin ?? (locations as Array<Record<string, unknown>>)[0];
        const coords = targetPin?.coordinates as { lat?: number; lng?: number } | null;
        if (coords?.lat != null && coords?.lng != null) {
          incidentCenter = { lat: coords.lat, lng: coords.lng };
          logger.info(
            { lat: coords.lat, lng: coords.lng, scenarioId },
            'AI agent: derived incident center from scenario_locations (center_lat/lng were null)',
          );
          // Backfill the scenario record so future loads are faster
          supabaseAdmin
            .from('scenarios')
            .update({ center_lat: coords.lat, center_lng: coords.lng })
            .eq('id', scenarioId)
            .then(({ error: backfillErr }) => {
              if (backfillErr) {
                logger.warn(
                  { error: backfillErr, scenarioId },
                  'Failed to backfill scenario center coords',
                );
              }
            });
        }
      }

      const locationSummary = (locations ?? [])
        .map((l: Record<string, unknown>) => {
          const coords = l.coordinates as { lat?: number; lng?: number } | null;
          const coordStr =
            coords?.lat != null && coords?.lng != null ? ` at [${coords.lat}, ${coords.lng}]` : '';
          return `- ${l.label} (${l.location_type})${coordStr}`;
        })
        .join('\n');

      const scenarioSummary = [
        `Title: ${scenario.title}`,
        `Type: ${scenario.category || 'general'}`,
        scenario.description ? `Description: ${scenario.description}` : '',
        incidentCenter ? `Incident Center: [${incidentCenter.lat}, ${incidentCenter.lng}]` : '',
        locationSummary ? `Key Locations:\n${locationSummary}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const teamList = (teams ?? []).map((t: Record<string, unknown>) => {
        const doctrineEntries = teamDoctrines[t.team_name as string] as
          | Array<{ title?: string; summary?: string }>
          | undefined;
        const doctrineText = doctrineEntries
          ? doctrineEntries.map((d) => `  - ${d.title || ''}: ${d.summary || ''}`).join('\n')
          : '';
        return {
          team_name: (t.team_name as string) || '',
          description: (t.team_description as string) || '',
          doctrines: doctrineText,
        };
      });

      return { scenarioSummary, sectorStandards, incidentCenter, teams: teamList };
    } catch (err) {
      logger.error({ error: err, scenarioId }, 'AI agents: failed to load scenario context');
      return null;
    }
  }

  private async loadBotProfile(
    botUserId: string,
  ): Promise<{ full_name: string; role: string; agency_name: string } | null> {
    try {
      const { data } = await supabaseAdmin
        .from('user_profiles')
        .select('full_name, role, agency_name')
        .eq('id', botUserId)
        .single();
      return data as { full_name: string; role: string; agency_name: string } | null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(session: SessionAgents, event: WebSocketEvent): Promise<void> {
    // Only react to inject.published — do NOT react to other bots' decisions/placements
    // to avoid the exponential feedback loop where each bot triggers all others.
    if (event.type !== 'inject.published') return;

    // New inject cycle: reset budget so agents can act again
    session.cycleDecisionCount = 0;
    session.lastInjectTs = Date.now();
    for (const [, agent] of session.agents) {
      agent.actedThisCycle = false;
    }

    logger.info(
      { sessionId: session.sessionId, eventType: event.type },
      'AI agents: new inject cycle started',
    );

    // Determine which teams this inject targets
    const injectData = (event.data as Record<string, unknown>)?.inject as
      | Record<string, unknown>
      | undefined;
    const targetTeams = (injectData?.target_teams as string[] | undefined) ?? [];
    const injectScope = (injectData?.inject_scope as string) ?? 'universal';
    const isUniversal = injectScope === 'universal' || targetTeams.length === 0;

    // Sequential agent responses: each agent waits for the previous to finish
    // so it can see what was already done and avoid duplicating actions.
    const agentEntries = Array.from(session.agents.entries());
    const runSequentially = async () => {
      for (let i = 0; i < agentEntries.length; i++) {
        if (session.stopped) return;
        if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) return;
        const [, agentState] = agentEntries[i];
        if (!this.canAct(agentState, session)) continue;
        if (agentState.actedThisCycle) continue;

        // Skip agents whose team is not targeted by this inject (unless universal)
        if (!isUniversal) {
          const teamLower = agentState.persona.teamName.toLowerCase();
          const isTargeted = targetTeams.some((t) => {
            const tl = t.toLowerCase();
            return teamLower.includes(tl) || tl.includes(teamLower);
          });
          if (!isTargeted) {
            logger.debug(
              {
                botUserId: agentState.persona.botUserId,
                team: agentState.persona.teamName,
                targetTeams,
              },
              'AI agent: skipping inject not targeted at this team',
            );
            continue;
          }
        }

        // Domain-relevance filter: only applies to universal/unscoped injects.
        // If the inject explicitly targets this team (via target_teams), never filter it out.
        if (isUniversal) {
          const injectTitle = (injectData?.title as string) ?? '';
          const injectDesc = (injectData?.description as string) ?? '';
          if (!isInjectRelevantToTeam(agentState.persona.teamName, injectTitle, injectDesc)) {
            logger.debug(
              {
                botUserId: agentState.persona.botUserId,
                team: agentState.persona.teamName,
                injectTitle,
              },
              'AI agent: skipping universal inject outside team domain',
            );
            continue;
          }
        }

        // Human-like delay before this agent responds
        const delay = AGENT_JITTER_BASE_MS + Math.random() * AGENT_JITTER_RANGE_MS;
        await new Promise((resolve) => setTimeout(resolve, delay));

        if (session.stopped) return;
        if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) return;

        try {
          await this.generateAndExecuteActions(session, agentState, event);
        } catch (err) {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId, eventType: event.type },
            'AI agent action failed',
          );
        }
      }
    };
    runSequentially().catch((err) => {
      logger.error({ error: err, sessionId: session.sessionId }, 'Sequential agent run failed');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleChannelEvent(_session: SessionAgents, _event: WebSocketEvent): void {
    // no-op: chat responses disabled to prevent feedback loops
  }

  // ---------------------------------------------------------------------------
  // Core AI response generation (consolidated turns)
  // ---------------------------------------------------------------------------

  private async generateAndExecuteActions(
    session: SessionAgents,
    agent: AgentState,
    triggerEvent: WebSocketEvent,
  ): Promise<void> {
    if (session.stopped) return;
    if (!this.canAct(agent, session)) return;
    if (agent.actedThisCycle && session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE)
      return;

    agent.lastActionTs = Date.now();
    agent.pendingCooldown = true;

    try {
      const systemPrompt = this.buildSystemPrompt(session, agent);
      const userPrompt = await this.buildUserPrompt(session, agent, triggerEvent);

      const response = await this.callOpenAI(systemPrompt, userPrompt);
      if (!response) {
        agent.pendingCooldown = false;
        return;
      }

      const actions = response.actions.filter((a) => a.action !== 'none');
      if (actions.length === 0) {
        agent.pendingCooldown = false;
        return;
      }

      // Limit to at most 3 actions (1 decision + 1 placement/claim + 1 chat)
      for (const action of actions.slice(0, 3)) {
        if (session.stopped) break;
        if (
          (action.action === 'decision' || action.action === 'pin_response') &&
          session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE
        ) {
          logger.info(
            { botUserId: agent.persona.botUserId },
            'AI agent: cycle decision budget exhausted, skipping decision/pin_response',
          );
          continue;
        }

        await this.executeSingleAction(session, agent, action, triggerEvent);

        if (action.action === 'decision' || action.action === 'pin_response') {
          session.cycleDecisionCount++;
        }

        const label =
          action.action === 'decision'
            ? `decision: ${action.decision?.title || ''}`
            : action.action === 'placement'
              ? `placement: ${action.placement?.asset_type} "${action.placement?.label}"`
              : action.action === 'claim'
                ? `claim: ${action.claim?.location_label} as ${action.claim?.claimed_as}`
                : action.action === 'pin_response'
                  ? `pin_response: ${action.pin_response?.target_type} "${action.pin_response?.target_label}" triage=${action.pin_response?.triage_color || 'none'}`
                  : action.action === 'chat'
                    ? `chat: ${action.chat?.content?.slice(0, 80) || ''}`
                    : action.action;

        agent.recentActions.push(`[${new Date().toISOString()}] ${label}`.slice(0, 200));

        if (actions.indexOf(action) < actions.length - 1) {
          await new Promise((r) =>
            setTimeout(r, INTER_ACTION_BASE_MS + Math.random() * INTER_ACTION_RANGE_MS),
          );
        }
      }

      agent.actedThisCycle = true;

      // Fallback: parse decision text for infrastructure mentions and auto-create placements.
      // Runs if no placement was included OR if included placements were blocked by team scope.
      const decisionAction = actions.find((a) => a.action === 'decision' && a.decision);
      if (decisionAction?.decision) {
        await this.tryExtractPlacementsFromDecision(
          session,
          agent,
          decisionAction.decision.title,
          decisionAction.decision.description,
        );
      }

      // Fallback: if the bot mentioned claiming exits but didn't include a claim action,
      // try to auto-claim exits from the decision text
      const hasClaim = actions.some((a) => a.action === 'claim');
      if (!hasClaim && decisionAction?.decision) {
        await this.tryExtractClaimsFromDecision(
          session,
          agent,
          decisionAction.decision.title,
          decisionAction.decision.description,
        );
      }

      if (response.reasoning) {
        logger.debug(
          { botUserId: agent.persona.botUserId, reasoning: response.reasoning },
          'AI agent reasoning',
        );
      }

      while (agent.recentActions.length > MAX_RECENT_ACTIONS) {
        agent.recentActions.shift();
      }
    } catch (err) {
      logger.error(
        { error: err, botUserId: agent.persona.botUserId },
        'AI agent generateAndExecuteActions error',
      );
    } finally {
      agent.pendingCooldown = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt builders
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(session: SessionAgents, agent: AgentState): string {
    const { persona } = agent;
    const parts: string[] = [
      `You are ${persona.fullName}, ${persona.agencyName}, assigned to team "${persona.teamName}" in a live multi-agency crisis management exercise.`,
      '',
      '## Scenario',
      session.scenarioSummary,
    ];

    if (persona.teamDescription) {
      parts.push('', '## Your Team Brief', persona.teamDescription);
    }
    if (session.sectorStandards) {
      parts.push('', '## Sector Standards & Regulations', session.sectorStandards);
    }
    if (persona.doctrines) {
      parts.push('', '## Your Team Doctrines', persona.doctrines);
    }

    parts.push(
      '',
      '## How This Exercise Works',
      '',
      'Each turn you return at most 3 actions in this order:',
      '1. ONE DECISION (a single, focused tactical action)',
      '2. ONE PLACEMENT or ONE CLAIM (map action matching your decision)',
      '3. ONE short CHAT message (radio summary of what you just did)',
      '',
      '### ⚠️ ONE ACTION PER DECISION — CRITICAL',
      'Your decision must describe EXACTLY ONE tactical action. Do NOT bundle multiple actions.',
      '- WRONG: "Establish triage point AND treat burn victim AND set up decon zone"',
      '- RIGHT: "Establish Triage Point in Warm Zone" (then next turn: "Triage Burn Victim near Gate B")',
      'If your decision mentions infrastructure placement, your action MUST be a "placement" — NOT a pin_response.',
      'If your decision mentions treating/extracting a patient, your action MUST be a "pin_response" — NOT a placement.',
      '',
      '### DECISIONS (the only thing that counts)',
      'Decisions appear in the War Room panel and are scored. Placements/chat without a decision score ZERO.',
      '- title: Concise and specific to the SINGLE action (e.g. "Establish Inner Cordon" or "Triage Burn Victim")',
      '- description: 2-3 sentences about the ONE action. Reference location, resources, procedure.',
      '',
      '### PLACEMENTS (visualize ONE key map action per decision)',
      '⚠️ CRITICAL: If your decision mentions establishing any infrastructure (cordon, triage tent, command post, assembly point, staging area, decon zone), you MUST include a placement action with it.',
      'A decision that says "establish inner cordon" WITHOUT a placement polygon is INCOMPLETE — the cordon will NOT appear on the map.',
      'If an inject says infrastructure is missing (e.g., "no triage tent deployed", "no cordon in place"), your response MUST include the placement action to fix it.',
      '',
      'Each placement MUST use the correct geometry type for its asset:',
      '',
      'POINT assets (single location): command_post, triage_point, tactical_unit, helicopter_lz, roadblock, observation_post, casualty_collection, forward_command, medic, fire_truck, ambulance, decontamination_zone',
      '  → geometry: { "type": "Point", "coordinates": [lng, lat] }',
      '',
      'POLYGON assets (enclosed area perimeter): inner_cordon, outer_cordon, staging_area, press_cordon, hot_zone, warm_zone, cold_zone, assembly_area',
      '  → geometry: { "type": "Polygon", "coordinates": [[[lng1,lat1], [lng2,lat2], ..., [lng1,lat1]]] }',
      '  → MUST be a closed ring (first and last coordinate identical)',
      '  → ⚠️ ALWAYS draw CIRCLES with 12 evenly-spaced points around the center, NOT squares or rectangles.',
      '',
      'LINESTRING assets (route/path): evacuation_route, patrol_route, supply_route',
      '  → geometry: { "type": "LineString", "coordinates": [[lng1,lat1], [lng2,lat2], [lng3,lat3]] }',
      '  → Minimum 2 waypoints, ideally 3-5 for realistic curves',
    );

    if (session.incidentCenter) {
      const { lat, lng } = session.incidentCenter;

      // Generate example circle coordinates for the prompt
      const makeCircle = (cLat: number, cLng: number, radiusDeg: number, n = 12): string => {
        const pts: string[] = [];
        for (let i = 0; i < n; i++) {
          const angle = (2 * Math.PI * i) / n;
          const pLng = cLng + radiusDeg * Math.cos(angle);
          const pLat = cLat + radiusDeg * Math.sin(angle);
          pts.push(`[${pLng.toFixed(5)},${pLat.toFixed(5)}]`);
        }
        pts.push(pts[0]); // close the ring
        return `[${pts.join(',')}]`;
      };

      const innerExample = makeCircle(lat, lng, 0.00045); // ~50m radius
      const outerExample = makeCircle(lat, lng, 0.0009); // ~100m radius
      const smallExample = makeCircle(lat, lng, 0.00027); // ~30m radius

      parts.push(
        '',
        '⚠️ COORDINATE SIZING — CRITICAL (polygons MUST be CIRCLES, 50m-100m radius):',
        `- Incident center: [${lat}, ${lng}]. All coordinates MUST be near this center.`,
        '- 0.001° ≈ 111 meters. Keep this scale in mind for ALL placements.',
        `- For POINTS: offset from center by ± 0.0002 to 0.0005 (22m to 55m).`,
        '',
        '⚠️ ALL POLYGONS MUST BE CIRCLES — 12 evenly-spaced points around a center point.',
        '  To make a circle: for i = 0..11: lng = centerLng + radius * cos(i * 30°), lat = centerLat + radius * sin(i * 30°)',
        '  Close the ring by repeating the first point at the end.',
        '',
        '- For INNER CORDON / OPERATING CORDON / BARRICADE PERIMETER: radius ≈ 0.00045 (~50m). Example:',
        `  { "type": "Polygon", "coordinates": [${innerExample}] }`,
        '',
        '- For OUTER CORDON / SECURITY PERIMETER: radius ≈ 0.0009 (~100m). Example:',
        `  { "type": "Polygon", "coordinates": [${outerExample}] }`,
        '',
        '- For STAGING/TRIAGE/ASSEMBLY/PRESS areas: radius ≈ 0.00027 (~30m). Example:',
        `  { "type": "Polygon", "coordinates": [${smallExample}] }`,
        '',
        '- For LINESTRINGS (routes): 2-5 waypoints, each offset by ± 0.0003 to 0.001 from center.',
        `  Example route: { "type": "LineString", "coordinates": [[${(lng - 0.0003).toFixed(5)},${(lat + 0.0003).toFixed(5)}], [${(lng + 0.0005).toFixed(5)},${(lat + 0.0008).toFixed(5)}]] }`,
        '',
        '⚠️ NEVER use squares or rectangles. ALWAYS use 12-point circles.',
        '⚠️ NEVER create polygons larger than radius 0.001 (~111m). The server will reject oversized polygons.',
      );
    }

    parts.push(
      '',
      '### CLAIMS (for exits and entry points)',
      'In the first minutes, CLAIM exits/entries relevant to your team before others take them.',
      '- location_label: exact label of the exit from the "Claimable Exits" list',
      '- claimed_as: how your team will use it (e.g. "evacuation_exit", "triage_staging", "casualty_entry", "media_access")',
      '- exclusivity: "exclusive" (only your team) or "shared"',
      '',
      '### PIN RESPONSE (interact with a specific casualty or hazard on the map)',
      '⚠️ MANDATORY: You MUST use pin_response (not a regular decision) when interacting with any casualty or hazard.',
      'A regular text decision about a casualty or hazard has NO physical effect on the map. ONLY pin_response actually updates the pin.',
      'If the Ground Situation lists casualties or hazards in your jurisdiction, your FIRST priority is to use pin_response on them.',
      '',
      '⚠️ PIN RESPONSE JURISDICTION — ONLY these teams may use pin_response:',
      '- TRIAGE / MEDICAL / EMS / AMBULANCE teams → pin_response on CASUALTIES (triage, treat, transport). These are the ONLY teams that may assign triage_color.',
      '- FIRE / HAZMAT teams → pin_response on HAZARDS (contain, mitigate, suppress).',
      '  FIRE / HAZMAT may ALSO respond to CASUALTIES but ONLY for extraction — NOT triage or treatment.',
      '  Fire/Hazmat extraction actions: basic first aid, apply safety equipment (SCBA, blanket, splint), package patient on stretcher/backboard, carry patient out of hot zone to warm zone or decon zone.',
      '  Fire/Hazmat MUST NOT assign triage_color (the server strips it). After extraction, hand off to Triage/Medical via chat.',
      '- EVACUATION teams → pin_response on CROWDS only (direct evacuation, not medical treatment)',
      '',
      'Teams that must NEVER use pin_response:',
      '- POLICE / SECURITY → Do NOT triage patients or mitigate hazards. Your job is cordons, exits, containment, pursuit. If you find casualties, radio medical/triage team in chat.',
      '- MEDIA / PRESS / PIO → Do NOT interact with any pins. Your job is public communication and media management only.',
      '- INTELLIGENCE / COMMAND → Do NOT interact with pins directly. Coordinate through other teams via chat.',
      '',
      'If a casualty or hazard appears and it is NOT your jurisdiction, send a CHAT message alerting the responsible team instead of using pin_response.',
      '',
      '- target_id: COPY the exact UUID from the casualties/hazards list below (the part inside [id:...]). This must be exact.',
      '- target_type: "casualty" or "hazard"',
      '- target_label: human-readable name (e.g. "Burn victims near Gate B")',
      '- actions: array of action labels you are taking (e.g. ["Initiate Triage", "Administer First Aid", "Apply Tourniquet"])',
      '- resources: array of resources deployed (e.g. [{ "type": "medic", "label": "Paramedic Team", "quantity": 2 }])',
      '- triage_color: for casualties only — assign based on severity: "green" (minor/walking), "yellow" (delayed/moderate), "red" (immediate/critical), or "black" (deceased)',
      '- description: brief description of what you are doing',
      '',
      'Example pin_response for a casualty:',
      '{ "action": "pin_response", "pin_response": { "target_id": "a1b2c3d4-...", "target_type": "casualty", "target_label": "Burn victims near Gate B", "actions": ["Initiate Triage", "Administer IV Fluids"], "resources": [{ "type": "medic", "label": "Paramedic Team Alpha", "quantity": 2 }], "triage_color": "red", "description": "Triaging critical burn victim, establishing IV access" } }',
      '',
      'Example pin_response for a hazard:',
      '{ "action": "pin_response", "pin_response": { "target_id": "e5f6g7h8-...", "target_type": "hazard", "target_label": "Chemical spill at Loading Bay", "actions": ["Deploy Containment Boom", "Establish Decon Corridor"], "resources": [{ "type": "hazmat_unit", "label": "HAZMAT Team Bravo", "quantity": 1 }], "description": "Containing chemical spill and setting up decontamination" } }',
      '',
      '## STATUS CHAIN RULES (must follow strictly)',
      'Every casualty and hazard follows a strict lifecycle. You can ONLY take actions valid for their current status.',
      '',
      '### Patient lifecycle:',
      '  undiscovered → identified → being_evacuated → at_assembly → endorsed_to_triage → in_treatment → endorsed_to_transport → transported',
      '  - You can TRIAGE (pin_response) patients that are: identified, at_assembly, endorsed_to_triage',
      '  - You can EXTRACT/EVACUATE patients that are: identified, undiscovered',
      '  - You can TRANSPORT patients ONLY if they are: in_treatment or endorsed_to_transport (they MUST be treated first!)',
      '  - You CANNOT transport a patient who has not been treated yet.',
      '  - You CANNOT skip steps (e.g. cannot go from "identified" straight to "transported").',
      '',
      '### Crowd lifecycle:',
      '  undiscovered → identified → being_evacuated → at_exit → at_assembly → resolved',
      '  - You can EVACUATE (direct_to) crowds that are: identified, undiscovered',
      '  - A crowd MUST have an explicit evacuation order with a named exit/destination before it moves.',
      '  - Crowds do NOT automatically evacuate just because an exit is claimed.',
      '',
      '### Hazard lifecycle:',
      '  active → escalating → contained → resolved',
      '  - You can CONTAIN hazards that are: active, escalating',
      '  - A hazard can only be RESOLVED after it has been CONTAINED first.',
      '  - Do NOT attempt to resolve a hazard that is still active/escalating — contain it first.',
      '',
      '### CHAT (1-2 sentences max)',
      'Professional radio comms. Reference YOUR decision. Acknowledge what other teams did.',
      '',
      '## ⚠️ INJECT CLASSIFICATION — READ THE INJECT CAREFULLY BEFORE RESPONDING',
      '⚠️ YOUR RESPONSE MUST DIRECTLY ADDRESS THE INJECT. Do NOT default to your standard playbook.',
      'Ask yourself: "What is this inject actually asking me to do?" — then respond to THAT, not your generic team action.',
      '',
      'STEP 1: Classify the inject:',
      '',
      'TYPE A — CASUALTY/HAZARD: The inject describes an injured person, a fire, a spill, etc.',
      '  → Use pin_response on the specific casualty/hazard pin if you have jurisdiction.',
      '',
      'TYPE B — EXTERNAL PRESSURE: Media approaching, civilians panicking, public complaints, crowd disruption.',
      '  → NOT casualties. Do NOT triage or treat them. Do NOT default to your team playbook.',
      '  → Respond with a DECISION that directly addresses the pressure described in the inject.',
      '',
      'TYPE C — STAKEHOLDER/DIPLOMATIC: Ambassador demands, government inquiry, VIP arrival, inter-agency request, family notifications.',
      '  → These require COMMUNICATION actions: prepare briefings, assign liaison officers, draft statements, compile status reports.',
      '  → Do NOT respond with infrastructure placement or medical procedures. Address the stakeholder need directly.',
      '',
      'TYPE D — SITUATIONAL UPDATE: Change in conditions (weather, escalation, resource arrival, intelligence update).',
      '  → Respond with a DECISION adapting your operations to the new situation.',
      '',
      'STEP 2: Match your response to the inject content:',
      '  ❌ WRONG: Inject says "ambassador demands safety updates" → You place a press cordon (that does not address the ambassador)',
      '  ❌ WRONG: Inject says "media approaching triage area" → You "Initiate Triage" on the media (media are not patients)',
      '  ❌ WRONG: Inject says "diplomatic pressure from ally government" → You run an evacuation protocol (not what was asked)',
      '',
      '  ✅ RIGHT: Inject says "ambassador demands safety updates" → Decision: "Compile attendee safety status report for Israeli consulate liaison"',
      '  ✅ RIGHT: Inject says "media approaching triage area" → Decision: "Request police to redirect press away from triage perimeter"',
      '  ✅ RIGHT: Inject says "diplomatic pressure from ally government" → Decision: "Assign senior officer as diplomatic liaison, prepare official briefing"',
      '  ✅ RIGHT: Inject says "civilians crowding exits" → Evacuation: "Deploy marshals to manage crowd flow at Gate B"',
      '',
      'RULE: Read the inject text. Identify what it ACTUALLY needs. Respond to THAT specific need. Do NOT substitute your default team action.',
      'RULE: If the inject describes people who are NOT injured/sick/contaminated, they are NOT casualties — no pin_response.',
      '',
      '## Response Format',
      '```json',
      '{',
      '  "actions": [',
      '    { "action": "decision", "decision": { "title": "...", "description": "..." } },',
      '    { "action": "placement", "placement": { ... } }  OR  { "action": "claim", "claim": { ... } }  OR  { "action": "pin_response", "pin_response": { "target_id": "...", "target_type": "casualty", "target_label": "...", "actions": [...], "resources": [...], "triage_color": "red", "description": "..." } },',
      '    { "action": "chat", "chat": { "content": "..." } }',
      '  ],',
      '  "reasoning": "Brief tactical thinking"',
      '}',
      '```',
      '',
      '## Tactical Phases',
      '- Minutes 0-3: CLAIM exits relevant to your team. Initial situation assessment. First containment decision.',
      '- Minutes 3-8: Deploy cordons/triage areas. Use PIN_RESPONSE to triage casualties one by one. Begin hazard containment.',
      '- Minutes 8-15: Continue triaging remaining casualties. Extract patients to triage areas. Specialist deployments. Begin evacuations only AFTER exits are claimed and cordons placed.',
      '- Minutes 15+: Treat patients at triage. Only transport AFTER treatment. Sustained ops, resource rotation. Resolve contained hazards.',
      '',
      '## CRITICAL Rules',
      '- Every turn MUST have exactly 1 decision (or 1 pin_response) + 1 placement/claim + 1 chat.',
      '- If your decision mentions establishing ANY infrastructure (cordon, triage, command post, staging, zone, decon, assembly point, roadblock, fire engine), you MUST ALSO include a placement action for it in the same turn.',
      '- If for some reason you cannot include a placement action, your decision text MUST include the exact coordinates [lat, lng] where the structure should be placed. This is a FALLBACK only — always prefer the placement action.',
      '- ALWAYS prefer pin_response over decision when there are casualties or hazards in your jurisdiction. A text decision CANNOT triage a patient or contain a hazard — only pin_response can.',
      '- Only use a regular decision when there are NO actionable casualties/hazards for your team, or for general operational actions (establishing cordons, requesting resources, coordinating).',
      '- Bundle ALL your tactical moves into ONE decision with a rich description.',
      '- NEVER place an inner_cordon or outer_cordon if one already exists.',
      '- READ "Recent actions" and "Ground situation" carefully. Address SPECIFIC casualties and hazards by name/location.',
      "- Focus EXCLUSIVELY on YOUR team specialty. Fire/HAZMAT handles fires. Triage/Medical handles casualties. Police handles security. Evacuation handles crowd movement. NEVER make decisions about another team's domain.",
      '- READ "Recent actions by all teams" CAREFULLY. If another team already addressed a fire, casualty, or hazard — DO NOT address the same one. Find something DIFFERENT to do.',
      '- Each decision must be UNIQUE — never repeat or closely resemble a previous decision by ANY team.',
      '- If the situation is stable and nothing new requires action, return { "actions": [{ "action": "none" }] }.',
      '- You are NOT expected to act every time. Real professionals wait, observe, and only act when there is something meaningful to address.',
      '- RESPECT THE STATUS CHAIN: check each casualty/hazard status before acting. Do NOT order transport for untreated patients, do NOT evacuate crowds that have not been given a direct movement order, do NOT resolve hazards that are not contained.',
      '- When writing decisions, be EXPLICIT about what you are doing. Say "transport burn victim at Gate B to Singapore General Hospital" NOT just "manage casualties". Vague decisions without named targets or destinations have NO effect on the map.',
    );

    // Difficulty-specific behavioral tuning
    parts.push('', '## Your Skill Level');
    switch (session.difficulty) {
      case 'novice':
        parts.push(
          'You are a NOVICE responder. You make realistic beginner mistakes:',
          '- Your decisions are often VAGUE — missing specific locations, headcounts, or procedures.',
          '- You sometimes forget to place a physical pin on the map when establishing infrastructure.',
          '- You occasionally overstep your team jurisdiction (e.g. triage team trying to do police work).',
          '- You rarely use proper professional terminology or reference standard operating procedures.',
          '- You may ignore active hazards or not check environmental conditions before deploying.',
          '- Your polygons for cordons are often too small or poorly positioned.',
          '- About 40% of your decisions should have some kind of quality issue.',
          '',
          '### Adversary Pursuit (if applicable)',
          '- If sighting injects appear with intel grades (like B2, D4), you tend to IGNORE the grade.',
          '- You commit resources impulsively to every sighting — even low-confidence ones.',
          '- You often fall for false leads and do NOT verify intelligence before deploying.',
          '- You rarely discuss source reliability or cross-reference multiple sightings.',
        );
        break;
      case 'advanced':
        parts.push(
          'You are an ADVANCED EXPERT responder with deep operational and game-mechanics knowledge.',
          'You play like a seasoned crisis management professional who understands every nuance of the system.',
          '',
          '### Zone Architecture (ownership rules)',
          'The scene requires 3 concentric zone polygons: HOT ZONE (innermost), WARM ZONE (buffer/staging), COLD ZONE (outermost).',
          "- ONLY the Police/Security team OR Fire/HAZMAT team draws these zone polygons. They are the Incident Commander's responsibility.",
          '- If you are Police/Security or Fire/HAZMAT: draw the zone polygons early as one of your first placements.',
          '- If you are ANY OTHER TEAM: do NOT draw zone polygons. Instead, REFERENCE the zones already drawn by police/fire when describing where you are operating.',
          '- If you see in "Deployed Infrastructure" that zone polygons already exist, do NOT redraw them. Work within what is already established.',
          '- The HOT zone tightly surrounds the incident and hazards. The WARM zone is larger (triage, decon). The COLD zone is outermost (command, media, assembly).',
          '',
          '### Cordon & Security Layers (Police/Security responsibility)',
          '- INNER CORDON and OUTER CORDON are drawn EXCLUSIVELY by the Police/Security team.',
          '- Other teams do NOT draw cordons. They request police to secure an area if needed.',
          '- Police must place outer cordon BEFORE other teams begin operations.',
          '- Every operational area should be placed INSIDE the appropriate zone polygon.',
          '',
          '### Equipment & Resource Specificity',
          '- When triaging or treating a patient, you MUST specify the equipment and resources being deployed:',
          '  → Fracture (broken leg, broken arm): specify splints, cervical collar, stretcher for transport. Moving a fracture patient without splints compromises stability.',
          '  → Burns: specify burn dressings, saline IV, cooling blankets. Severity dictates resources.',
          '  → Bleeding/hemorrhage: specify tourniquets, pressure dressings, hemostatic agents.',
          '  → Crush injury: specify hydraulic rescue tools, spine board, IV fluids for crush syndrome prevention.',
          '  → Smoke inhalation: specify oxygen therapy, nebulizer, airway management kit.',
          '  → Chemical exposure: specify decontamination shower, antidote kits, PPE level for responders.',
          '- When transporting, specify the vehicle type: ambulance for critical patients, bus for walking wounded, helicopter for time-critical transfers.',
          '- When containing a hazard, specify: fire extinguisher type (ABC, CO2, foam), containment booms for spills, ventilation fans for gas, PPE level required.',
          '',
          '### Triage Protocol (START/SALT)',
          '- Use START triage systematically: check RPM (Respiration, Perfusion, Mental status).',
          '- GREEN (minor): walking wounded, can wait. Assign to assembly point.',
          '- YELLOW (delayed): serious but stable. Needs treatment within 1 hour. Move to warm zone triage.',
          '- RED (immediate): life-threatening, needs treatment NOW. Priority for field hospital or immediate transport.',
          '- BLACK (deceased/expectant): no pulse, not breathing after airway cleared. Tag and document.',
          '- Triage patients ONE AT A TIME using pin_response. Each patient gets individual attention.',
          '',
          '### MANDATORY Structures Before Operations',
          'You MUST place the following infrastructure on the map BEFORE engaging with any pins:',
          '- COMMAND POST (Point asset in cold zone): every team must have a command post. Place it first. Label it clearly (e.g., "Police Command Post", "Medical Command Post").',
          '- TEAM STAGING AREA (Point or Polygon in cold/warm zone): where your team assembles equipment and personnel before deployment.',
          '- For Police: command post + outer cordon BEFORE any security operations.',
          '- For Fire/HAZMAT: command post + staging area + decon corridor BEFORE entering hot zone.',
          '- For Medical/Triage: command post + triage tent (inside warm zone) BEFORE any patient contact.',
          '- For Evacuation: command post + assembly points BEFORE issuing any evacuation orders.',
          '- For Media: command post + media staging area BEFORE issuing any statements.',
          '- If your command post and team structures are NOT placed, your first action MUST be to place them. No exceptions.',
          '',
          '### Protective Gear & Equipment Prerequisites',
          'When interacting with a pin (casualty or hazard via pin_response), you MUST specify the protective gear and equipment for the responders themselves — not just the patient treatment:',
          '- Hot zone entry: Level A/B/C PPE (specify which), SCBA (self-contained breathing apparatus), turnout gear, personal dosimeter if radiological.',
          '- Casualty handling: disposable gloves (minimum), face shield/mask, body fluid protection gown for contaminated patients.',
          '- Fracture handling: the responder needs: gloves, stretcher, rigid splints, cervical collar. WITHOUT specifying stretcher/splints, the patient movement will compromise the fracture.',
          '- Burn treatment: the responder needs: sterile gloves, burn kit, IV cannulation kit, fluid warmer.',
          '- Chemical casualty: FULL decon BEFORE treatment. Responder needs: Level B/C suit, decon shower access. Patient goes through decon corridor first.',
          '- Fire suppression: turnout gear, SCBA, thermal imaging camera, appropriate extinguishing agent.',
          '- Structural collapse: hard hat, steel-toe boots, hydraulic rescue tools, timber shoring.',
          '- If you interact with a pin WITHOUT specifying protective gear and appropriate equipment, the AI evaluator will flag this as an operational gap.',
          '',
          '### Operational Sequencing (expert knows the correct order)',
          '1. FIRST: Place COMMAND POST for your team in the cold zone → this is your base.',
          '2. SECOND (Police/Security ONLY): Establish outer cordon, claim exits, draw hot/warm/cold zone polygons.',
          "3. THIRD (Fire/HAZMAT ONLY): If police hasn't drawn zones yet, draw them. Place decon corridor. Assess hazards.",
          '4. FOURTH: Place team-specific infrastructure INSIDE the appropriate zone (triage tent in warm zone, assembly point in cold zone, etc.).',
          '5. FIFTH: Begin pin_response interactions — one casualty/hazard at a time. Specify all equipment AND PPE.',
          '6. SIXTH: Follow jurisdiction rules for patient movement:',
          '   - HOT ZONE extraction: ONLY Fire/HAZMAT or trained HAZMAT paramedics extract patients from hot zone to warm zone boundary. They wear full PPE.',
          '   - WARM ZONE treatment: Medical/Triage team receives patients at the warm zone boundary. They triage and treat.',
          '   - COLD ZONE transport: Medical team arranges transport from warm/cold zone to hospital.',
          '   - If you are NOT Fire/HAZMAT, do NOT enter the hot zone. Request fire team to extract casualties to you.',
          '7. SEVENTH: Transport treated patients to named hospital → only after treatment, with named vehicle.',
          '8. THROUGHOUT: Contain and mitigate hazards (fire/HAZMAT only). Other teams support from outside.',
          '',
          '### Responding to Injects (CRITICAL)',
          'The Injects Panel shows time-based events, consequences, and situational updates during the exercise.',
          '- You MUST read and respond to the inject that triggered your current turn.',
          '- If the inject describes a new threat, casualty, or situation change — address it directly in your decision.',
          '- If the inject is a consequence of a previous failure (e.g., "fire has spread", "suspect escaped"), acknowledge it and take corrective action.',
          '- If the inject is a specificity failure or environmental inconsistency feedback — fix the issue in your next decision (e.g., place the missing equipment, correct the approach).',
          '- ⚠️ IMPORTANT: If the inject says infrastructure is MISSING (e.g., "no triage tent", "no cordon", "no command post"), your response MUST include a PLACEMENT action to create it. Writing about it in text is NOT enough — the physical asset must appear on the map.',
          '- Do NOT ignore injects. Every inject requires acknowledgment and a team-appropriate response.',
          '- If the inject is not relevant to your team (e.g., fire update for evacuation team), acknowledge in chat but do not take action outside your jurisdiction.',
          '',
          '### How to Construct Your Answer (MANDATORY format)',
          'Every decision description MUST follow this structure:',
          '',
          '**1. SITUATION ASSESSMENT (1 sentence):**',
          'State what you are responding to. Reference the inject or ground situation by name.',
          'Example: "In response to the reported fire spread at Level 2 corridor, ..."',
          '',
          '**2. ACTION (specific):**',
          'State exactly what you are doing. Name the target by location/description.',
          'Example: "...deploying Engine Company Alpha to suppress the fire at Level 2 east wing corridor."',
          '',
          '**3. EQUIPMENT LIST (specific items from available resources):**',
          'Name every piece of equipment being used. Do NOT say "appropriate equipment" — list them.',
          'Example: "Equipment: 2x 38mm hose lines (60m each), 1x thermal imaging camera, Class A foam concentrate, 1x positive pressure ventilation fan."',
          '',
          '**4. PERSONNEL ASSIGNMENT (exact numbers):**',
          'Assign specific numbers of personnel by role. Do NOT say "a team" — give exact count and role.',
          'Example: "Personnel: 4 firefighters from Engine Company Alpha (2 on hose line, 1 on ventilation, 1 as safety officer), supervised by Station Officer Tan."',
          '',
          '**5. PROTECTIVE GEAR (for the responders):**',
          'State what PPE the responders are wearing. This is required for any hot/warm zone operation.',
          'Example: "PPE: Full turnout gear, SCBA (30-min cylinders), flash hoods, heat-resistant gloves."',
          '',
          '**6. EXPECTED OUTCOME (1 sentence):**',
          'State what you expect to achieve.',
          'Example: "Expected to contain the fire within 15 minutes, preventing spread to Level 3."',
          '',
          '### Spatial Awareness',
          '- Every decision should reference WHERE on the map the action is happening.',
          '- When placing a triage tent, put it in the warm zone, near an exit for efficient patient flow.',
          '- When placing an assembly point, put it in the cold zone, away from hazards.',
          '- Evacuation routes (LineString) should connect the incident area through exits to assembly points.',
          '- Do NOT place triage inside the hot zone — it is dangerous and operationally incorrect.',
          '',
          '### Coordination & Jurisdiction',
          '- Reference what other teams have done and build on their work.',
          '- Fire/HAZMAT clears the hot zone → then medical can operate at the warm zone boundary.',
          '- Police secures cordons → then evacuation can direct crowds through secured exits.',
          '- Medical triages and treats → then transport arranges ambulance to hospital.',
          "- NEVER do another team's job. If you need something outside your jurisdiction, REQUEST it in chat.",
          '- Use proper radio protocol: state your team, your action, your location, your resource request.',
          '',
          '### Expert Decision Quality',
          '- Your decisions are always OPERATIONALLY SPECIFIC: exact locations, exact personnel counts, exact equipment lists, procedure names.',
          '- You reference sector standards and doctrines by name.',
          '- You check environmental conditions and hazard status before committing resources.',
          '- Virtually all your decisions should be sound, well-formed, and actionable.',
          '- You respond to ALL environmental truths: insider knowledge, hazard properties, casualty conditions.',
          '- NEVER use vague language like "appropriate resources", "a team", "necessary equipment". Always name specifics.',
          '',
          '### Adversary Pursuit Intelligence (EXPERT)',
          'When sighting injects appear with NATO intel grades, apply analytical rigor:',
          '- ALWAYS reference the NATO grade in your decision text (e.g., "This B2-graded sighting from CCTV...").',
          '- Source Reliability: A=completely reliable, B=usually reliable, C=fairly reliable, D=not usually reliable, E=unreliable, F=cannot judge.',
          '- Information Credibility: 1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable.',
          '- A high-reliability source CAN deliver wrong information (e.g., CCTV capturing the wrong person). The source grade and the truth are independent.',
          '- For A1-B2 sightings: commit resources with confidence but verify — maintain reserves.',
          '- For C3-D4 sightings: exercise caution. Discuss in team chat. Deploy observation only, not full commitment.',
          '- For E5-F5 sightings: treat with EXTREME skepticism. Do NOT commit resources. Request corroboration from a second source before acting.',
          '- When a sighting appears AFTER a previous one in a different direction: analyze if the movement pattern makes sense. Fleeing suspects follow logical paths.',
          '- Cross-reference multiple sightings: if an E5 bystander sighting aligns with a B2 CCTV sighting in the same corridor, the E5 gains credibility.',
          '- If you identify a potential false lead, mention it in chat: "B2 sighting at Car Park B may be a civilian — contradicts the A1 body camera direction of travel."',
          '- The system silently tracks your resource allocation to sighting tips — wasting resources on false leads incurs heat penalties.',
        );

        // Team-specific expert playbook
        this.appendTeamExpertPlaybook(parts, agent.persona.teamName);
        break;
      default: // intermediate
        parts.push(
          'You are an INTERMEDIATE responder with solid but imperfect skills:',
          '- Most of your decisions are reasonably specific, but occasionally you miss a detail.',
          '- You usually place pins when establishing infrastructure, but might forget sometimes.',
          '- You generally stay within your team jurisdiction with occasional minor overlap.',
          '- You use some professional terminology but may not always cite specific standards.',
          '- About 15-20% of your decisions should have minor quality issues.',
          '',
          '### Adversary Pursuit (if applicable)',
          "- When sighting injects appear with intel grades (like B2, D4), you acknowledge them but don't always act on the grading systematically.",
          '- You sometimes commit resources to medium-confidence sightings without fully evaluating.',
          "- You occasionally discuss source reliability in chat but don't consistently apply critical analysis.",
          '- You may catch one false lead but miss others — your judgment is decent but imperfect.',
        );
    }

    return parts.join('\n');
  }

  private async buildUserPrompt(
    session: SessionAgents,
    agent: AgentState,
    event: WebSocketEvent,
  ): Promise<string> {
    const parts: string[] = [];
    const elapsed = this.getElapsedMinutes(session);
    parts.push(`## Current Situation — ${Math.floor(elapsed)} minutes into exercise`);
    parts.push('');

    if (event.type === 'session.started' || event.type === 'proactive.tick') {
      parts.push(`Trigger: ${event.data.message || 'Periodic situation reassessment'}`);
    } else {
      parts.push(`New event: ${event.type}`);
      parts.push(JSON.stringify(event.data, null, 2).slice(0, 1200));
    }

    // Always tell the bot about the strict phase sequence
    const teamScopeKey = getTeamScopeKey(agent.persona.teamName);
    const requiredInfra = getRequiredInfrastructure(agent.persona.teamName);
    const requiredStr =
      requiredInfra.length > 0 ? requiredInfra.map((r) => r.replace(/_/g, ' ')).join(', ') : 'none';

    parts.push(
      '',
      '## ⚠️ STRICT OPERATIONAL PHASES — you MUST follow this sequence',
      'Phase 1 (CLAIMING): Claim exits/entries. Already handled automatically — skip this phase.',
      `Phase 2 (ESTABLISHING): Place your team's required infrastructure: [${requiredStr}].`,
      '  → You MUST complete Phase 2 before doing ANYTHING else. Use a "placement" action.',
      '  → Do NOT combine establishing infrastructure with treating patients in the same decision.',
      'Phase 3 (OPERATIONAL): Only after your infrastructure exists on the map, respond to casualties/hazards/crowds using "pin_response".',
      '  → The server BLOCKS pin_response if your infrastructure is missing.',
      '',
      '## ⚠️ ONE ACTION PER DECISION — CRITICAL RULE',
      '- Each decision must focus on ONE specific action. Do NOT combine multiple actions in one decision.',
      '- WRONG: "Establish triage area AND treat patient AND claim exit" in one decision.',
      '- RIGHT: Decision 1 = "Establish triage area" (placement). Decision 2 = "Triage burn victim" (pin_response).',
      '- If you want to place infrastructure, submit ONLY a placement action (no pin_response in the same turn).',
      '- If you want to respond to a casualty/hazard, submit ONLY a pin_response (no placement in the same turn).',
    );

    if (elapsed < FOUNDATIONAL_PHASE_MINUTES) {
      parts.push(
        '',
        '## ⚠️ FOUNDATIONAL PHASE (first 8 minutes) — INFRASTRUCTURE PRIORITY',
        `Your required infrastructure: [${requiredStr}]. If not yet placed, your ONLY action this turn must be a placement.`,
        'Do NOT respond to any casualties, hazards, or crowds until your infrastructure is on the map.',
        teamScopeKey === 'police' || teamScopeKey === 'security'
          ? '→ Step 1: PLACE outer cordon polygon. Step 2: PLACE roadblocks/barricades at entry points to physically block access. Cordons alone are just lines on a map — barricades/roadblocks make them enforceable.'
          : teamScopeKey === 'triage' || teamScopeKey === 'medical' || teamScopeKey === 'ems'
            ? '→ Step 1: PLACE triage point (tent location). Step 2: PLACE inner cordon polygon around the triage area to create an operating perimeter. Personnel and supplies deploy after infrastructure is on the map.'
            : teamScopeKey === 'fire' || teamScopeKey === 'hazmat'
              ? '→ Step 1: PLACE forward command post. Step 2: PLACE staging area for equipment and personnel.'
              : teamScopeKey === 'evacuation'
                ? '→ PLACE assembly point / marshal post for evacuee gathering.'
                : teamScopeKey === 'media'
                  ? '→ Step 1: PLACE press cordon polygon. Step 2: PLACE media staging area inside it.'
                  : '→ PLACE your operating area.',
      );
    }

    // Ground situation: casualties, hazards, claimable exits
    const ground = await this.loadGroundSituation(session.sessionId, session.scenarioId);

    if (ground.claimableExits.length > 0) {
      const unclaimed = ground.claimableExits.filter((e) => !e.claimStatus.startsWith('CLAIMED'));
      if (unclaimed.length > 0) {
        parts.push('', '## Unclaimed Exits & Entries (available to claim):');
        for (const exit of unclaimed) {
          parts.push(`- "${exit.label}" (${exit.location_type}) — ${exit.claimStatus}`);
        }
      }
      const claimed = ground.claimableExits.filter((e) => e.claimStatus.startsWith('CLAIMED'));
      if (claimed.length > 0) {
        parts.push('', '## Already Claimed Exits (do NOT re-claim):');
        for (const exit of claimed) {
          parts.push(`- "${exit.label}" (${exit.location_type}) — ${exit.claimStatus}`);
        }
      }
    }

    if (ground.casualties.length > 0) {
      parts.push('', '## Casualties on the ground:');
      for (const c of ground.casualties) {
        parts.push(`- ${c}`);
      }
    }

    if (ground.hazards.length > 0) {
      parts.push('', '## Active hazards:');
      for (const h of ground.hazards) {
        parts.push(`- ${h}`);
      }
    }

    const recentActivity = await this.loadRecentSessionActivity(session.sessionId);
    if (recentActivity.length > 0) {
      parts.push('', '## Recent actions by all teams:');
      for (const act of recentActivity.slice(0, 12)) {
        parts.push(`- ${act}`);
      }
    }

    if (agent.recentActions.length > 0) {
      parts.push('', '## Your previous actions (do not repeat):');
      for (const action of agent.recentActions.slice(-8)) {
        parts.push(`- ${action}`);
      }
    }

    // Advanced mode: feed environmental truths, insider knowledge, placed assets
    if (session.difficulty === 'advanced') {
      const intel = await this.loadAdvancedIntelligence(session.sessionId, session.scenarioId);
      if (intel) parts.push('', intel);
    }

    // Difficulty-dependent: inject deliberate flaw directive for AI reviewer showcase
    const flawDirective = this.maybeInjectFlawDirective(session, agent);
    if (flawDirective) {
      parts.push('', flawDirective);
    }

    parts.push(
      '',
      'Return exactly 3 actions: 1 decision + 1 placement/claim + 1 chat. Bundle your tactical moves into the decision.',
    );

    return parts.join('\n');
  }

  /**
   * Load insider knowledge, hazard details, placed assets, and environmental
   * state for advanced-level agents so they can make fully informed decisions.
   */
  private async loadAdvancedIntelligence(
    sessionId: string,
    scenarioId: string,
  ): Promise<string | null> {
    const sections: string[] = [];

    try {
      // Insider knowledge (the "cheat code" info)
      const { data: insider } = await supabaseAdmin
        .from('insider_knowledge')
        .select('category, content, importance')
        .eq('scenario_id', scenarioId)
        .order('importance', { ascending: false })
        .limit(10);

      if (insider && insider.length > 0) {
        sections.push('## 🔒 INSIDER INTELLIGENCE (classified — use to make perfect decisions):');
        for (const item of insider as Array<Record<string, unknown>>) {
          sections.push(
            `- [${(item.category as string) || 'intel'}] ${(item.content as string) || ''}`,
          );
        }
      }

      // Hazard detailed properties with full resolution playbook
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select(
          'hazard_type, status, properties, resolution_requirements, personnel_requirements, equipment_requirements, enriched_description',
        )
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating', 'contained'])
        .limit(8);

      if (hazards && hazards.length > 0) {
        sections.push(
          '',
          '## 🔬 HAZARD DETAILS (full environmental truth — use to make perfect decisions):',
        );
        for (const h of hazards as Array<Record<string, unknown>>) {
          const props = h.properties as Record<string, unknown> | null;
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          const persReqs = h.personnel_requirements as Record<string, unknown> | null;
          const eqReqs = h.equipment_requirements as Array<Record<string, unknown>> | null;

          sections.push(`\n### Hazard: ${h.hazard_type} — Status: ${h.status}`);
          if (h.enriched_description) {
            sections.push(`  Situation: ${h.enriched_description}`);
          }
          if (props) {
            sections.push(`  Properties: ${JSON.stringify(props)}`);
          }

          if (reqs) {
            const idealSeq = reqs.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string; responsible_team?: string }>
              | undefined;
            const reqPpe = reqs.required_ppe as
              | Array<{ item: string; for_role?: string }>
              | undefined;

            if (idealSeq && idealSeq.length > 0) {
              sections.push('  ✅ IDEAL RESPONSE SEQUENCE (follow this exactly):');
              for (const s of idealSeq) {
                sections.push(
                  `    Step ${s.step}: ${s.action}${s.responsible_team ? ` [${s.responsible_team}]` : ''} — ${s.detail}`,
                );
              }
            }
            if (reqPpe && reqPpe.length > 0) {
              sections.push(
                `  🧤 REQUIRED PPE: ${reqPpe.map((p) => `${p.item}${p.for_role ? ` (${p.for_role})` : ''}`).join(', ')}`,
              );
            }
            const safetyPrecautions = reqs.safety_precautions as string[] | undefined;
            if (safetyPrecautions && safetyPrecautions.length > 0) {
              sections.push(`  ⚠️ Safety precautions: ${safetyPrecautions.join('; ')}`);
            }
            if (reqs.approach_method) {
              sections.push(`  Approach method: ${reqs.approach_method}`);
            }
            if (reqs.estimated_resolution_minutes) {
              sections.push(
                `  Expected resolution time: ~${reqs.estimated_resolution_minutes} minutes`,
              );
            }
          }

          if (persReqs) {
            sections.push(
              `  Personnel: ${persReqs.primary_responder ?? 'unknown'} x${persReqs.minimum_count ?? '?'}${persReqs.specialist_needed ? `, specialist: ${persReqs.specialist_type}` : ''}${(persReqs.support_roles as string[])?.length ? `, support: ${(persReqs.support_roles as string[]).join(', ')}` : ''}`,
            );
          }

          if (eqReqs && eqReqs.length > 0) {
            sections.push(
              `  Equipment: ${eqReqs.map((e) => `${e.label || e.equipment_type} x${e.quantity}${e.critical ? ' [CRITICAL]' : ''}`).join(', ')}`,
            );
          }
        }
      }

      // Casualty detailed conditions with full ideal response playbook
      const { data: casualties } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, casualty_type, headcount, status, conditions')
        .eq('session_id', sessionId)
        .in('status', [
          'undiscovered',
          'identified',
          'endorsed_to_triage',
          'in_treatment',
          'being_evacuated',
          'at_assembly',
        ])
        .limit(15);

      if (casualties && casualties.length > 0) {
        const patients = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'patient',
        );
        const crowds = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'crowd' || c.casualty_type === 'evacuee_group',
        );
        const convergent = (casualties as Array<Record<string, unknown>>).filter(
          (c) => c.casualty_type === 'convergent_crowd',
        );

        if (patients.length > 0) {
          sections.push(
            '',
            '## 🏥 PATIENT DETAILS (full clinical truth — use to make perfect decisions):',
          );
          for (const c of patients) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            const idShort = (c.id as string).slice(0, 8);
            sections.push(`\n### Patient [${idShort}] — Status: ${c.status}`);
            sections.push(
              `  Triage: ${conds.triage_color ?? 'unassessed'}, Mobility: ${conds.mobility ?? 'unknown'}, Consciousness: ${conds.consciousness ?? 'unknown'}, Breathing: ${conds.breathing ?? 'unknown'}`,
            );

            const injuries = conds.injuries as
              | Array<{ type: string; severity: string; body_part: string }>
              | undefined;
            if (injuries?.length) {
              sections.push(
                `  Injuries: ${injuries.map((i) => `${i.severity} ${i.type} (${i.body_part})`).join('; ')}`,
              );
            }

            const treatReqs = conds.treatment_requirements as
              | Array<{ intervention: string; priority: string; reason: string }>
              | undefined;
            if (treatReqs?.length) {
              sections.push(
                `  Required treatment: ${treatReqs.map((t) => `${t.intervention} [${t.priority}] — ${t.reason}`).join('; ')}`,
              );
            }

            const transPrereqs = conds.transport_prerequisites as string[] | undefined;
            if (transPrereqs?.length) {
              sections.push(`  Before transport: ${transPrereqs.join(', ')}`);
            }

            const contraindications = conds.contraindications as string[] | undefined;
            if (contraindications?.length) {
              sections.push(`  ⛔ Do NOT: ${contraindications.join(', ')}`);
            }

            const idealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (idealSeq?.length) {
              sections.push('  ✅ IDEAL RESPONSE SEQUENCE (follow this exactly):');
              for (const s of idealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const reqPpe = conds.required_ppe as string[] | undefined;
            if (reqPpe?.length) {
              sections.push(`  🧤 PPE for responder: ${reqPpe.join(', ')}`);
            }

            const reqEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (reqEquip?.length) {
              sections.push(
                `  🔧 Equipment needed: ${reqEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const expectedTime = conds.expected_time_to_treat_minutes as number | undefined;
            if (expectedTime) {
              sections.push(`  ⏱️ Expected treatment time: ~${expectedTime} minutes`);
            }
          }
        }

        if (crowds.length > 0) {
          sections.push('', '## 👥 CROWD DETAILS (use to make perfect evacuation decisions):');
          for (const c of crowds) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            sections.push(
              `\n### Crowd (${c.headcount} people) — Status: ${c.status}, Behavior: ${conds.behavior ?? 'unknown'}`,
            );
            if (conds.visible_description) {
              sections.push(`  Visible: ${conds.visible_description}`);
            }
            if (conds.blocking_exit) {
              sections.push(`  ⚠️ Blocking exit: ${conds.blocking_exit}`);
            }
            if (conds.bottleneck) {
              sections.push('  ⚠️ Bottleneck risk: YES');
            }
            if (conds.movement_direction) {
              sections.push(`  Moving: ${conds.movement_direction}`);
            }

            const crowdIdealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (crowdIdealSeq?.length) {
              sections.push('  ✅ IDEAL CROWD MANAGEMENT SEQUENCE:');
              for (const s of crowdIdealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const crowdEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (crowdEquip?.length) {
              sections.push(
                `  Equipment: ${crowdEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const crowdPersonnel = conds.required_personnel as
              | { role: string; count: number }
              | undefined;
            if (crowdPersonnel) {
              sections.push(`  Personnel: ${crowdPersonnel.count}x ${crowdPersonnel.role}`);
            }

            if (conds.management_priority) {
              sections.push(`  Priority: ${conds.management_priority}`);
            }
          }
        }

        if (convergent.length > 0) {
          sections.push('', '## 🚶 CONVERGENT CROWD DETAILS (arriving from outside):');
          for (const c of convergent) {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            sections.push(
              `\n### ${conds.crowd_origin ?? 'Unknown'} group (${c.headcount} people) — Status: ${c.status}, Behavior: ${conds.behavior ?? 'unknown'}`,
            );
            if (conds.visible_description) {
              sections.push(`  Visible: ${conds.visible_description}`);
            }
            if (conds.obstruction_risk) {
              sections.push(`  Obstruction risk: ${conds.obstruction_risk}`);
            }

            const convIdealSeq = conds.ideal_response_sequence as
              | Array<{ step: number; action: string; detail: string }>
              | undefined;
            if (convIdealSeq?.length) {
              sections.push('  ✅ IDEAL MANAGEMENT SEQUENCE:');
              for (const s of convIdealSeq) {
                sections.push(`    Step ${s.step}: ${s.action} — ${s.detail}`);
              }
            }

            const convEquip = conds.required_equipment as
              | Array<{ item: string; quantity: number; purpose: string }>
              | undefined;
            if (convEquip?.length) {
              sections.push(
                `  Equipment: ${convEquip.map((e) => `${e.item} x${e.quantity} (${e.purpose})`).join('; ')}`,
              );
            }

            const convPersonnel = conds.required_personnel as
              | { role: string; count: number }
              | undefined;
            if (convPersonnel) {
              sections.push(`  Personnel: ${convPersonnel.count}x ${convPersonnel.role}`);
            }
          }
        }
      }

      // Currently placed assets (so agent knows what infrastructure exists)
      const { data: placed } = await supabaseAdmin
        .from('placed_assets')
        .select('asset_type, label, team_name, geometry')
        .eq('session_id', sessionId)
        .eq('status', 'active')
        .limit(20);

      if (placed && placed.length > 0) {
        sections.push('', '## 🗺️ DEPLOYED INFRASTRUCTURE (what is on the map right now):');
        for (const p of placed as Array<Record<string, unknown>>) {
          const geom = p.geometry as { type?: string } | null;
          sections.push(
            `- ${p.asset_type} "${p.label}" by ${p.team_name} (${geom?.type || 'unknown'})`,
          );
        }
      }
    } catch (err) {
      logger.warn({ error: err, sessionId }, 'AI agent: failed to load advanced intelligence');
    }

    return sections.length > 0 ? sections.join('\n') : null;
  }

  /**
   * Append team-specific expert playbook so each role knows the "complete
   * answer" for their domain — equipment, procedures, sequencing, and
   * what a perfect response looks like.
   */
  private appendTeamExpertPlaybook(parts: string[], teamName: string): void {
    const t = teamName.toLowerCase();

    if (t.includes('police') || t.includes('security') || t.includes('law')) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: POLICE / SECURITY',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Deploy OUTER CORDON polygon immediately — this is your #1 priority. Size it wide enough to keep ALL civilians, media, and bystanders away from the scene.',
        '2. Establish ACCESS CONTROL POINTS at each exit/entry — claim exits as "security_checkpoint" with exclusivity. Only authorized personnel pass through.',
        '3. Deploy INNER CORDON polygon around the hot zone — tighter perimeter. Only specialized responders (fire, medical) enter with your authorization.',
        '4. Assign officers to each cordon segment — specify headcount: "4 officers on north inner cordon, 2 on south outer cordon".',
        '5. Establish a COMMAND POST in the cold zone — place as a Point asset with label "Incident Command Post".',
        '6. Coordinate access requests — when medical team needs to enter hot zone, you authorize and log entry.',
        '',
        '#### Equipment You Must Specify:',
        '- Cordon tape / barriers / traffic cones for physical perimeter',
        '- Body-worn cameras for evidence preservation',
        '- Portable radios (specific channel assignments)',
        '- Vehicle barriers (bollards, patrol cars) for vehicle exclusion zones',
        '- Loudhailer / PA system for crowd dispersal orders',
        '- Crime scene tape and evidence markers (if secondary device or forensic scene)',
        '',
        '#### Situational Awareness:',
        '- ALWAYS check for secondary threats before declaring an area secure',
        '- If scenario involves an active threat (shooter, bomber), establish "safe corridor" LineStrings for evacuation routes BEFORE medical teams enter',
        '- If crowds are panicking near your cordon, request crowd management reinforcements with specific numbers',
        '- Preserve evidence inside the hot zone — instruct fire/medical teams to minimize disturbance',
        '- If media arrives, designate a MEDIA STAGING AREA in the cold zone as a placed asset',
        '- Log and track every person entering/exiting the inner cordon (state this in your decision)',
      );
    }

    if (t.includes('fire') || t.includes('hazmat') || t.includes('scdf')) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: FIRE / HAZMAT',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Assess the hazard type FIRST — read the hazard pin properties. Is it fire, chemical, gas, structural? This determines your equipment.',
        '2. Establish PPE level for your team BEFORE approaching:',
        '   - Level A: full encapsulation suit + SCBA (chemical/biological unknowns)',
        '   - Level B: splash protection + SCBA (known chemical, no vapor threat)',
        '   - Level C: splash protection + APR (known chemical, low concentration)',
        '   - Level D: standard turnout gear (fire only, no chemical)',
        '3. Place a DECONTAMINATION CORRIDOR in the warm zone — this is a polygon between hot and cold zones. All responders exiting hot zone must pass through.',
        '4. Attack the hazard with pin_response — specify exact equipment and agent:',
        '   - Class A fire (ordinary combustibles): water, foam',
        '   - Class B fire (flammable liquids): foam, CO2, dry chemical',
        '   - Class C fire (electrical): CO2, dry chemical (NEVER water)',
        '   - Class D fire (combustible metals): special dry powder',
        '   - Chemical spill: containment booms, absorbent pads, neutralizing agents',
        '   - Gas leak: gas detectors, ventilation fans, spark-free tools',
        '5. Monitor for re-ignition or hazard escalation — request ongoing monitoring with thermal imaging cameras.',
        '6. Only declare "contained" when the hazard is no longer spreading. Only declare "resolved" after full suppression and atmospheric monitoring confirms safe.',
        '',
        '#### Equipment You Must Specify:',
        '- Fire: fire engine with pump capacity (e.g., "2000 LPM pumper"), hose lines (specify length/diameter), thermal imaging camera, ventilation fans',
        '- HAZMAT: gas detection meters (4-gas detector, PID), decon shower system, containment booms, absorbent materials, chemical reference database (ERG guide)',
        '- Rescue: hydraulic rescue tools (jaws of life, spreaders, cutters) for entrapment, shoring equipment for structural collapse',
        '- Personnel: specify crew size ("Engine Company Alpha, 4 firefighters" not just "a fire team")',
        '',
        '#### Critical Rules:',
        '- YOU are the ONLY team authorized to enter the hot zone. No medical, police, or evacuation team enters until you declare it safe.',
        '- Hot zone casualty extraction is YOUR exclusive job: locate casualties, stabilize with basic DRABC, carry them on stretcher with full PPE to the warm zone boundary. Then radio medical to take over.',
        '- Check wind direction before positioning (upwind approach for HAZMAT)',
        '- Structural assessment before entry — if building is compromised, request structural engineer before sending crews in',
        '- Establish a water supply point and specify hydrant location or tanker',
        '- When responding to an inject about fire spread or hazard escalation, your decision MUST name: which engine company, how many firefighters, what hose line diameter, what agent, what PPE level.',
      );
    }

    if (
      t.includes('triage') ||
      t.includes('medical') ||
      t.includes('health') ||
      t.includes('ems') ||
      t.includes('ambulance')
    ) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: TRIAGE / MEDICAL / EMS',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Place a TRIAGE TENT inside the warm zone, near an exit — this is your base of operations. It must be a placed asset on the map.',
        '2. If mass casualties expected, place a FIELD HOSPITAL (larger polygon) in the cold zone for extended treatment.',
        '3. Begin SYSTEMATIC TRIAGE using pin_response — one patient at a time, using START protocol:',
        '   - Can they walk? → GREEN (minor)',
        '   - Breathing after airway opened? → No → BLACK (deceased)',
        '   - Respiratory rate > 30? → RED (immediate)',
        '   - Radial pulse absent or CRT > 2 sec? → RED (immediate)',
        '   - Cannot follow commands? → RED (immediate)',
        '   - Otherwise → YELLOW (delayed)',
        '4. After triage, TREAT patients based on color priority (RED first, then YELLOW):',
        '   - Each treatment must specify the exact intervention and equipment.',
        '5. When a patient is TREATED and STABLE, arrange TRANSPORT to a named hospital with a specific vehicle.',
        '',
        '#### Equipment By Injury Type (MUST specify in pin_response):',
        '- Fracture (limb): rigid splint (SAM splint), elastic bandage, sling. If open fracture: sterile dressing first, then splint. Stretcher for non-ambulatory.',
        '- Fracture (spinal/cervical): cervical collar, spine board, head blocks, straps. DO NOT move without full spinal immobilization.',
        '- Burns (minor, <10% BSA): cool running water 20 min, burns dressing, cling film, oral analgesia.',
        '- Burns (major, >20% BSA): IV access (2 large bore), Parkland formula fluids (4ml × kg × %BSA), burns dressing, intubation kit if airway burns.',
        '- Hemorrhage (external): direct pressure, tourniquet (limb), hemostatic gauze (junctional), pressure dressing.',
        '- Hemorrhage (internal/suspected): IV fluids, rapid transport, pelvic binder if pelvic fracture suspected.',
        '- Crush injury: IV normal saline BEFORE extrication (prevents crush syndrome), calcium gluconate, sodium bicarbonate, cardiac monitor.',
        '- Smoke inhalation: high-flow oxygen (15L NRB mask), nebulized salbutamol, intubation kit on standby.',
        '- Chemical exposure: full decontamination BEFORE treatment. Remove contaminated clothing. Specific antidotes if known (atropine for nerve agent, pralidoxime).',
        '- Blast injury: check for tympanic membrane rupture, blast lung (oxygen, no positive pressure), embedded shrapnel (do NOT remove, stabilize in place).',
        '- Psychological trauma: quiet area in cold zone, crisis counselor, blanket, warm drink. Do not sedate.',
        '',
        '#### Transport Requirements:',
        '- GREEN patients: walking or by bus to assembly point. No ambulance needed.',
        '- YELLOW patients: ambulance transport within 1 hour. Specify destination hospital.',
        '- RED patients: immediate ambulance, specify hospital by name (e.g., "Singapore General Hospital Trauma Centre"). If >20 min drive, request helicopter.',
        '- BLACK patients: remain on scene, covered, with documentation. Coroner notification.',
        '- ALWAYS specify: patient count per vehicle, escort personnel, handover protocol.',
        '',
        '#### Critical Rules:',
        '- NEVER enter the hot zone without fire team clearance — wait for "scene safe" confirmation',
        '- Set up casualty collection point at hot/warm zone boundary — fire team brings patients TO you',
        '- Track patient numbers: state how many GREEN/YELLOW/RED/BLACK at each decision point',
        '- If hospital capacity is an issue, mention load-balancing across facilities',
        '- Request specific specialist resources by exact count and role: "2 paramedics with ALS capability, 1 triage officer, 3 stretcher bearers" — NEVER just "medical team"',
        '- Every pin_response MUST list: equipment items by name, responder count, PPE worn by responders, expected outcome',
      );
    }

    if (t.includes('evac') || t.includes('civil') || t.includes('crowd') || t.includes('shelter')) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: EVACUATION / CIVIL DEFENSE',
        '',
        '#### Your Perfect Response Sequence:',
        '1. CLAIM exits early — decide which exits your team will manage. Specify exclusive or shared.',
        '2. Place ASSEMBLY POINTS as placed assets in the cold zone — one for each major exit route. Name them clearly.',
        '3. Draw EVACUATION ROUTES as LineString assets — from the incident area through your claimed exits to assembly points.',
        '4. Assess crowd pins — how many people, what behavior (calm, anxious, panicking)? This determines approach.',
        '5. Issue EVACUATION ORDERS via decision — name the specific crowd, the exit they should use, and the assembly point destination.',
        '6. Deploy MARSHALS along routes — specify headcount at each point: "4 marshals at Exit B corridor, 2 at assembly point entrance".',
        '7. Conduct HEADCOUNT at assembly point — verify expected vs actual evacuees. Report discrepancies.',
        '',
        '#### Equipment You Must Specify:',
        '- Megaphones / PA system for crowd direction',
        '- High-visibility vests for marshals (specify count)',
        '- Barrier tape for route channeling',
        '- Wheelchairs / evacuation chairs for mobility-impaired (specify count based on building type)',
        '- Signage / directional arrows for route marking',
        '- Headcount clickers / registration sheets at assembly points',
        '- Buses for mass transport from assembly point if needed (specify capacity and count)',
        '',
        '#### Crowd Management Expertise:',
        '- Calculate EXIT FLOW RATE: ~60 people/min through a standard door. If 500 people need evacuating through 2 exits = ~4 minutes minimum.',
        '- PANICKING crowds need calming BEFORE orderly evacuation. Deploy trained marshals with PA first.',
        '- Do NOT send a panicking crowd toward a narrow exit — they will crush. Open additional exits or calm first.',
        '- VULNERABLE POPULATIONS: identify elderly, disabled, children. These need assisted evacuation with specific equipment (evac chairs, guides).',
        '- If stampede risk detected, STOP evacuation and stabilize before resuming.',
        '- Separate walking wounded (GREEN tag patients) from crowd evacuees — they go to different assembly points.',
        '',
        '#### Critical Rules:',
        '- Do NOT begin evacuation until police confirms the exit route is SECURE (outer cordon in place)',
        '- If a hazard is between the crowd and the exit, DO NOT use that exit — reroute through a safe alternative',
        '- Assembly points must be UPWIND of any fire/chemical hazard',
        '- Communicate with medical team about mixed wounded in crowds — some evacuees may collapse en route',
        '- Track numbers: "Evacuated 350 of estimated 500 through Exit B. 150 remaining in Level 2."',
      );
    }

    if (
      t.includes('media') ||
      t.includes('comms') ||
      t.includes('communication') ||
      t.includes('public')
    ) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: MEDIA / COMMUNICATIONS',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Establish MEDIA STAGING AREA as a placed asset in the cold zone — away from operations but with line of sight.',
        '2. Draft initial PUBLIC STATEMENT — confirm incident type, state response is underway, do NOT speculate on casualties or cause.',
        '3. Designate a SPOKESPERSON and brief them — specify by role, not by name.',
        '4. Monitor and respond to SOCIAL MEDIA reports — flag misinformation for correction.',
        '5. Issue periodic UPDATES with verified information only — casualties confirmed by medical, cause confirmed by investigation.',
        '6. Coordinate with all teams before releasing sensitive information — especially casualty numbers and cause.',
        '',
        '#### Equipment You Must Specify:',
        '- Press briefing area: podium, microphone, backdrop',
        '- Social media monitoring station: laptop, mobile hotspot',
        '- Media credentials / access passes for authorized press',
        '- Pre-prepared holding statements and Q&A templates',
        '',
        '#### Public Sentiment Awareness:',
        '- Your decisions directly affect PUBLIC SENTIMENT meter — careless statements damage trust.',
        '- Acknowledge the situation without speculation: "We are aware of an incident at [location]. Emergency services are responding."',
        '- If misinformation is spreading, issue CORRECTION statements quickly.',
        '- If casualties are involved, express concern without confirming numbers until verified by medical team.',
        '- Coordinate with police on whether to release suspect information (active threat vs resolved).',
      );
    }

    if (
      t.includes('intel') ||
      t.includes('investigation') ||
      t.includes('negotiat') ||
      t.includes('detective')
    ) {
      parts.push(
        '',
        '### EXPERT PLAYBOOK: INTELLIGENCE / INVESTIGATION / NEGOTIATION',
        '',
        '#### Your Perfect Response Sequence:',
        '1. Gather situation reports from all teams — build a COMMON OPERATING PICTURE.',
        '2. Assess threat level: is this ongoing, resolved, or at risk of escalation? Are there secondary threats?',
        '3. If active threat (hostage, active shooter): establish CONTAINMENT perimeter, negotiate if possible, coordinate tactical response.',
        '4. Identify and preserve EVIDENCE — mark locations, instruct teams not to disturb, request forensics.',
        '5. Conduct WITNESS INTERVIEWS — identify key witnesses, establish safe interview area in cold zone.',
        '6. Brief Incident Commander on threat assessment and recommended course of action.',
        '',
        '#### Equipment You Must Specify:',
        '- Evidence markers and collection kits',
        '- CCTV / surveillance access requests (specify camera locations)',
        '- Tactical communications (encrypted channel)',
        '- Negotiation phone/line if hostage situation',
        '- Forensic team with specialized equipment (specify: CBRN detection, explosive ordnance disposal, digital forensics)',
        '',
        '#### Critical Rules:',
        '- Check for SECONDARY DEVICES or threats — especially in bombing scenarios. Report all suspicious items.',
        '- If suspects are identified, coordinate with police for containment — do NOT send medical teams into an area with active threat',
        '- Preserve chain of custody for all evidence',
        '- Brief all teams on threat updates in real-time via chat',
      );
    }

    // Fallback for teams that don't match any specific playbook
    if (
      !t.includes('police') &&
      !t.includes('security') &&
      !t.includes('law') &&
      !t.includes('fire') &&
      !t.includes('hazmat') &&
      !t.includes('scdf') &&
      !t.includes('triage') &&
      !t.includes('medical') &&
      !t.includes('health') &&
      !t.includes('ems') &&
      !t.includes('ambulance') &&
      !t.includes('evac') &&
      !t.includes('civil') &&
      !t.includes('crowd') &&
      !t.includes('shelter') &&
      !t.includes('media') &&
      !t.includes('comms') &&
      !t.includes('communication') &&
      !t.includes('public') &&
      !t.includes('intel') &&
      !t.includes('investigation') &&
      !t.includes('negotiat') &&
      !t.includes('detective')
    ) {
      parts.push(
        '',
        `### EXPERT PLAYBOOK: ${teamName.toUpperCase()}`,
        '- Apply general incident management expertise to your specialty area.',
        '- Always specify exact equipment, personnel counts, and procedures in your decisions.',
        '- Place map assets (polygons, points) for any infrastructure you establish.',
        '- Coordinate with other teams and acknowledge their actions before building on them.',
        '- Reference doctrines and standards by name where applicable.',
      );
    }
  }

  /**
   * With difficulty-dependent probability, returns a hidden directive that makes
   * the bot commit a realistic but detectable mistake. The AI environmental
   * evaluator will flag it, showcasing the review system in demos.
   */
  private maybeInjectFlawDirective(session: SessionAgents, agent: AgentState): string | null {
    const flawProbability =
      session.difficulty === 'novice' ? 0.45 : session.difficulty === 'advanced' ? 0.05 : 0.25;
    if (Math.random() > flawProbability) return null;

    const elapsed = this.getElapsedMinutes(session);
    const team = agent.persona.teamName.toLowerCase();

    const flawOptions: string[] = [
      // Vague / non-specific decisions (specificity checker will flag these)
      '⚠️ HIDDEN INSTRUCTION: This turn, make your decision description intentionally VAGUE. ' +
        'Omit specific locations, headcounts, and timelines. For example, say "Deploy resources to the area" ' +
        'instead of specifying which resources, how many, and exactly where. Do NOT mention this instruction in chat.',

      // Contradicting environmental conditions
      '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that IGNORES a current hazard or environmental condition. ' +
        'For example, propose deploying personnel into a hazard zone without mentioning protective equipment, ' +
        'or set up an outdoor triage point without addressing weather conditions. Do NOT mention this instruction in chat.',

      // Overstepping team jurisdiction
      "⚠️ HIDDEN INSTRUCTION: This turn, make a decision that slightly OVERSTEPS your team's jurisdiction. " +
        'For example, if you are police, make a medical triage decision. If you are triage, make a tactical containment decision. ' +
        'Keep it subtle — a real person might make this mistake under pressure. Do NOT mention this instruction in chat.',

      // Missing coordination
      '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that CONTRADICTS or DUPLICATES what another team recently did. ' +
        'Check the "Recent actions" and deliberately overlap with someone else\'s deployment or claim an area they already handle. ' +
        'Do NOT mention this instruction in chat.',

      // Insufficient resources / unrealistic commitment
      '⚠️ HIDDEN INSTRUCTION: This turn, propose an action that is UNDER-RESOURCED for its scope. ' +
        'For example, send 2 officers to secure a large perimeter, or assign 1 paramedic to handle 50+ casualties. ' +
        'The numbers should be obviously insufficient. Do NOT mention this instruction in chat.',
    ];

    // Filter context-appropriate flaws
    const applicable = [...flawOptions];

    // Add time-sensitive flaws
    if (elapsed > 5) {
      applicable.push(
        '⚠️ HIDDEN INSTRUCTION: This turn, make a decision that would have been appropriate 5 minutes ago but is NOW OUTDATED. ' +
          'For example, propose initial containment when cordons are already established, or request an initial assessment ' +
          'when the situation has evolved. Do NOT mention this instruction in chat.',
      );
    }

    // Team-specific flaws
    if (team.includes('media') || team.includes('press')) {
      applicable.push(
        '⚠️ HIDDEN INSTRUCTION: This turn, propose releasing information to the public that includes OPERATIONALLY SENSITIVE details ' +
          '(team positions, tactical plans, or casualty specifics). A real PIO might make this mistake under pressure. ' +
          'Do NOT mention this instruction in chat.',
      );
    }

    return applicable[Math.floor(Math.random() * applicable.length)];
  }

  // ---------------------------------------------------------------------------
  // OpenAI call
  // ---------------------------------------------------------------------------

  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AgentMultiResponse | null> {
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
          temperature: 0.7,
          max_tokens: 1400,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'AI agent OpenAI call failed');
        return null;
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as Record<string, unknown>;

      if (Array.isArray(parsed.actions)) {
        return parsed as unknown as AgentMultiResponse;
      }
      if (typeof parsed.action === 'string') {
        return {
          actions: [parsed as unknown as SingleAction],
          reasoning: parsed.reasoning as string | undefined,
        };
      }
      return null;
    } catch (err) {
      logger.error({ error: err }, 'AI agent: OpenAI call exception');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  private async executeSingleAction(
    session: SessionAgents,
    agent: AgentState,
    action: SingleAction,
    triggerEvent?: WebSocketEvent,
  ): Promise<void> {
    const { sessionId, channelId } = session;
    const { botUserId, teamName } = agent.persona;

    // Extract trigger inject text for relevance checks
    const triggerInjectData =
      triggerEvent?.type === 'inject.published'
        ? ((triggerEvent.data as Record<string, unknown>)?.inject as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const triggerInjectText = triggerInjectData
      ? `${(triggerInjectData.title as string) ?? ''} ${(triggerInjectData.description as string) ?? (triggerInjectData.content as string) ?? ''}`.toLowerCase()
      : '';

    switch (action.action) {
      case 'decision': {
        if (!action.decision) break;

        // Fallback: if the decision text mentions a casualty/hazard UUID,
        // auto-convert to a pin_response so the pin actually gets updated
        const converted = await this.tryConvertDecisionToPinResponse(
          session,
          agent,
          action.decision.title,
          action.decision.description,
          triggerInjectText,
        );
        if (converted) {
          // Block auto-conversion for teams without pin jurisdiction
          if (this.isTeamBlockedFromPinResponse(teamName, converted.target_type)) {
            logger.info(
              { botUserId, teamName, targetType: converted.target_type },
              'AI agent: skipping auto-converted pin_response — team has no jurisdiction',
            );
          } else {
            // Phase gate: block if team hasn't set up infrastructure yet
            const convReqAssets = getRequiredInfrastructure(teamName);
            let infraReady = true;
            if (convReqAssets.length > 0) {
              const { data: convExisting } = await supabaseAdmin
                .from('placed_assets')
                .select('asset_type')
                .eq('session_id', sessionId)
                .eq('team_name', teamName)
                .eq('status', 'active')
                .in('asset_type', convReqAssets);
              const convPlaced = new Set(
                (convExisting ?? []).map(
                  (a) => (a as Record<string, unknown>).asset_type as string,
                ),
              );
              infraReady = convReqAssets.every((r) => convPlaced.has(r));
            }
            if (!infraReady) {
              logger.info(
                { botUserId, teamName },
                'AI agent: skipping auto-converted pin_response — infrastructure not established',
              );
            } else {
              logger.info(
                { botUserId, targetId: converted.target_id, targetType: converted.target_type },
                'AI agent: auto-converted decision to pin_response (decision text referenced a pin)',
              );
              await this.dispatcher.respondToPin(sessionId, botUserId, teamName, converted);
              break;
            }
          }
        }

        await this.dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
          title: action.decision.title,
          description: action.decision.description,
        });
        break;
      }

      case 'placement': {
        if (!action.placement) break;
        if (!isPlacementAllowedForTeam(teamName, action.placement.asset_type)) {
          logger.warn(
            { botUserId, teamName, assetType: action.placement.asset_type },
            'AI agent: placement blocked — asset type not allowed for this team',
          );
          break;
        }
        const geometry = this.translateGeometry(action.placement.geometry, session.incidentCenter);
        await this.dispatcher.createPlacement(sessionId, botUserId, {
          team_name: teamName,
          asset_type: action.placement.asset_type,
          label: action.placement.label || action.placement.asset_type.replace(/_/g, ' '),
          geometry,
          properties: action.placement.properties,
        });
        break;
      }

      case 'claim': {
        if (!action.claim?.location_label) break;
        const locationId = await this.resolveLocationId(
          session.scenarioId,
          action.claim.location_label,
        );
        if (locationId) {
          await this.dispatcher.claimLocation(
            sessionId,
            locationId,
            teamName,
            action.claim.claimed_as || 'operational_use',
            action.claim.exclusivity,
          );
        }
        break;
      }

      case 'pin_response': {
        if (!action.pin_response?.target_id) {
          logger.warn(
            { botUserId, pinResponse: action.pin_response },
            'AI agent: pin_response missing target_id, skipping',
          );
          break;
        }
        // Phase gate: block pin_response until team's required infrastructure is placed
        const requiredAssets = getRequiredInfrastructure(teamName);
        if (requiredAssets.length > 0) {
          const { data: existingAssets } = await supabaseAdmin
            .from('placed_assets')
            .select('asset_type')
            .eq('session_id', sessionId)
            .eq('team_name', teamName)
            .eq('status', 'active')
            .in('asset_type', requiredAssets);
          const placedTypes = new Set(
            (existingAssets ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
          );
          const missing = requiredAssets.filter((r) => !placedTypes.has(r));
          if (missing.length > 0) {
            logger.info(
              { botUserId, teamName, missing },
              'AI agent: pin_response blocked — team must establish infrastructure first',
            );
            break;
          }
        }
        // Server-side jurisdiction guard: block teams that shouldn't interact with pins
        if (this.isTeamBlockedFromPinResponse(teamName, action.pin_response.target_type)) {
          logger.warn(
            { botUserId, teamName, targetType: action.pin_response.target_type },
            'AI agent: pin_response blocked — team has no jurisdiction over this pin type',
          );
          break;
        }
        const pr = action.pin_response;
        logger.info(
          { botUserId, targetId: pr.target_id, targetType: pr.target_type, label: pr.target_label },
          'AI agent: executing pin_response',
        );

        // Fire/Hazmat teams can extract casualties but cannot assign triage colors
        const teamKey = getTeamScopeKey(teamName);
        const stripTriage =
          teamKey && EXTRACT_ONLY_TEAMS.has(teamKey) && pr.target_type === 'casualty';

        await this.dispatcher.respondToPin(sessionId, botUserId, teamName, {
          target_id: pr.target_id,
          target_type: pr.target_type,
          target_label: pr.target_label || 'Unknown target',
          actions: pr.actions || [],
          resources: pr.resources || [],
          triage_color: stripTriage ? undefined : pr.triage_color,
          description: pr.description || '',
        });
        break;
      }

      case 'chat': {
        if (!action.chat?.content || !channelId) break;
        await this.dispatcher.sendChatMessage(channelId, sessionId, botUserId, action.chat.content);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private canAct(agent: AgentState, session: SessionAgents): boolean {
    if (agent.pendingCooldown) return false;
    if (agent.actedThisCycle && session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE)
      return false;
    const now = Date.now();
    const isEarly = this.getElapsedMinutes(session) < FOUNDATIONAL_PHASE_MINUTES;
    const throttle = isEarly ? AGENT_THROTTLE_EARLY_MS : AGENT_THROTTLE_MS;
    if (now - agent.lastActionTs < throttle) return false;
    if (session.scriptAware && session.scriptNextEventTs > 0) {
      if (session.scriptNextEventTs - now < HYBRID_DEFER_WINDOW_MS) return false;
    }
    return true;
  }

  private getElapsedMinutes(session: SessionAgents): number {
    return (Date.now() - session.startedAt) / 60_000;
  }

  private extractOriginatorId(event: WebSocketEvent): string | null {
    const data = event.data;
    const decision = data.decision as Record<string, unknown> | undefined;
    if (decision?.proposed_by) return decision.proposed_by as string;
    const placement = data.placement as Record<string, unknown> | undefined;
    if (placement?.placed_by) return placement.placed_by as string;
    const message = data.message as Record<string, unknown> | undefined;
    if (message?.sender_id) return message.sender_id as string;
    return null;
  }

  private translateGeometry(
    geometry: { type: string; coordinates: unknown },
    center: { lat: number; lng: number } | null,
  ): { type: string; coordinates: unknown } {
    if (!center) return this.clampPolygonSize(geometry, center);

    const isNearOrigin = (coord: number[]): boolean =>
      Math.abs(coord[0]) < 1 && Math.abs(coord[1]) < 1;
    const translate = (coord: number[]): number[] => [coord[0] + center.lng, coord[1] + center.lat];

    try {
      if (geometry.type === 'Point') {
        const coords = geometry.coordinates as number[];
        if (Array.isArray(coords) && coords.length >= 2 && isNearOrigin(coords)) {
          return { type: 'Point', coordinates: translate(coords) };
        }
      } else if (geometry.type === 'LineString') {
        const coords = geometry.coordinates as number[][];
        if (Array.isArray(coords) && coords.length > 0 && isNearOrigin(coords[0])) {
          return { type: 'LineString', coordinates: coords.map(translate) };
        }
      } else if (geometry.type === 'Polygon') {
        const rings = geometry.coordinates as number[][][];
        if (
          Array.isArray(rings) &&
          rings.length > 0 &&
          rings[0].length > 0 &&
          isNearOrigin(rings[0][0])
        ) {
          return { type: 'Polygon', coordinates: rings.map((ring) => ring.map(translate)) };
        }
      }
    } catch {
      // geometry already absolute or malformed
    }
    return this.clampPolygonSize(geometry, center);
  }

  /**
   * Shrink oversized polygons so they don't span unrealistically large areas.
   * Max allowed span: ~0.004° (~440m). If larger, scale coordinates toward centroid.
   */
  private clampPolygonSize(
    geometry: { type: string; coordinates: unknown },
    center: { lat: number; lng: number } | null,
  ): { type: string; coordinates: unknown } {
    if (geometry.type !== 'Polygon') return geometry;
    const MAX_SPAN = 0.002; // ~220m diameter — fits 100m radius circles

    try {
      const rings = geometry.coordinates as number[][][];
      if (!Array.isArray(rings) || rings.length === 0 || rings[0].length < 4) return geometry;

      const ring = rings[0];
      let minLng = Infinity,
        maxLng = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
      for (const c of ring) {
        if (c[0] < minLng) minLng = c[0];
        if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      }

      const spanLng = maxLng - minLng;
      const spanLat = maxLat - minLat;

      if (spanLng <= MAX_SPAN && spanLat <= MAX_SPAN) return geometry;

      const scaleFactor = Math.min(
        MAX_SPAN / Math.max(spanLng, 0.0001),
        MAX_SPAN / Math.max(spanLat, 0.0001),
      );
      const cLng = center?.lng ?? (minLng + maxLng) / 2;
      const cLat = center?.lat ?? (minLat + maxLat) / 2;

      const scaled = rings.map((r) =>
        r.map((coord) => [
          cLng + (coord[0] - cLng) * scaleFactor,
          cLat + (coord[1] - cLat) * scaleFactor,
        ]),
      );

      logger.info(
        {
          originalSpan: { lng: spanLng.toFixed(5), lat: spanLat.toFixed(5) },
          scaleFactor: scaleFactor.toFixed(3),
        },
        'AI agent: clamped oversized polygon',
      );

      return { type: 'Polygon', coordinates: scaled };
    } catch {
      return geometry;
    }
  }

  /**
   * When the LLM outputs a decision instead of a pin_response but the text
   * clearly references a specific casualty/hazard UUID, auto-convert it so
   * the pin actually gets updated on the map and the spectator panel fires.
   */
  private async tryConvertDecisionToPinResponse(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
    triggerInjectText?: string,
  ): Promise<{
    target_id: string;
    target_type: 'casualty' | 'hazard';
    target_label: string;
    actions: string[];
    resources: Array<{ type: string; label: string; quantity: number }>;
    triage_color?: 'green' | 'yellow' | 'red' | 'black';
    description: string;
  } | null> {
    const fullText = `${title} ${description}`.toLowerCase();

    // Look for UUID patterns that match known casualties or hazards
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const foundIds = fullText.match(uuidPattern);
    if (foundIds?.length) {
      // Check casualties first
      const { data: casualty } = await supabaseAdmin
        .from('scenario_casualties')
        .select('id, casualty_type, conditions, status')
        .eq('session_id', session.sessionId)
        .in('id', foundIds)
        .limit(1)
        .maybeSingle();

      if (casualty) {
        const conds = (casualty.conditions as Record<string, unknown>) ?? {};
        const vis = (conds.visible_description as string) || (conds.injury_type as string) || '';
        const triageColor = this.inferTriageColor(fullText, conds);
        return {
          target_id: casualty.id as string,
          target_type: 'casualty',
          target_label: vis || `${casualty.casualty_type} (${casualty.status})`,
          actions: this.inferActionsFromText(fullText, 'casualty'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          triage_color: triageColor,
          description: description.slice(0, 300),
        };
      }

      // Check hazards
      const { data: hazard } = await supabaseAdmin
        .from('scenario_hazards')
        .select('id, hazard_type, status')
        .eq('session_id', session.sessionId)
        .in('id', foundIds)
        .limit(1)
        .maybeSingle();

      if (hazard) {
        return {
          target_id: hazard.id as string,
          target_type: 'hazard',
          target_label: `${hazard.hazard_type} (${hazard.status})`,
          actions: this.inferActionsFromText(fullText, 'hazard'),
          resources: [{ type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 }],
          description: description.slice(0, 300),
        };
      }
    }

    // Also detect keyword-based references to casualties/hazards without UUIDs.
    // BUT FIRST: if the trigger inject describes a non-medical/non-hazard situation
    // (media, diplomats, VIPs, crowds without injuries), do NOT auto-convert even
    // if the bot's generated text mentions triage/treatment keywords.
    const NON_MEDICAL_INJECT_PATTERNS =
      /media|press|journalist|reporter|camera|diplomat|ambassador|consul|official|vip|dignitar|politic|protest|complain|public (concern|outrage|pressure)|social media|broadcast|interview|crowd.*(approach|gather|watch|curious)/i;
    const ACTUAL_INJURY_IN_INJECT =
      /injur|wound|bleed|casualt|victim|burn|fractur|unconscious|cardiac|breathing|pain|trauma|contaminat|expos|collapse/i;

    if (
      triggerInjectText &&
      NON_MEDICAL_INJECT_PATTERNS.test(triggerInjectText) &&
      !ACTUAL_INJURY_IN_INJECT.test(triggerInjectText)
    ) {
      logger.debug(
        { botUserId: agent.persona.botUserId, team: agent.persona.teamName },
        'AI agent: skipping keyword-based pin_response auto-conversion — trigger inject is not a medical/hazard situation',
      );
      return null;
    }

    const casualtyKeywords =
      /triage|treat|first aid|tourniquet|administer|assess (patient|casualt|victim|injur)/i;
    const hazardKeywords =
      /contain (fire|spill|leak|chemical)|suppress fire|extinguish|deploy foam|hazmat/i;

    if (casualtyKeywords.test(fullText) || hazardKeywords.test(fullText)) {
      const isCasualty = casualtyKeywords.test(fullText);
      const table = isCasualty ? 'scenario_casualties' : 'scenario_hazards';
      const statusFilter = isCasualty
        ? ['undiscovered', 'identified', 'endorsed_to_triage', 'at_assembly']
        : ['active', 'escalating'];

      const { data: targets } = await supabaseAdmin
        .from(table)
        .select('id, status, ' + (isCasualty ? 'casualty_type, conditions' : 'hazard_type'))
        .eq('session_id', session.sessionId)
        .in('status', statusFilter)
        .limit(1);

      if (targets?.length) {
        const target = targets[0] as unknown as Record<string, unknown>;
        if (isCasualty) {
          const conds = (target.conditions as Record<string, unknown>) ?? {};
          const vis = (conds.visible_description as string) || '';
          return {
            target_id: target.id as string,
            target_type: 'casualty',
            target_label: vis || `${target.casualty_type} (${target.status})`,
            actions: this.inferActionsFromText(fullText, 'casualty'),
            resources: [
              { type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 },
            ],
            triage_color: this.inferTriageColor(fullText, conds),
            description: description.slice(0, 300),
          };
        } else {
          return {
            target_id: target.id as string,
            target_type: 'hazard',
            target_label: `${target.hazard_type} (${target.status})`,
            actions: this.inferActionsFromText(fullText, 'hazard'),
            resources: [
              { type: 'responder', label: `${agent.persona.teamName} Team`, quantity: 1 },
            ],
            description: description.slice(0, 300),
          };
        }
      }
    }

    return null;
  }

  private inferTriageColor(
    text: string,
    conditions: Record<string, unknown>,
  ): 'green' | 'yellow' | 'red' | 'black' {
    const existing = conditions.triage_color as string | undefined;
    if (existing && ['green', 'yellow', 'red', 'black'].includes(existing))
      return existing as 'green' | 'yellow' | 'red' | 'black';
    if (/critical|immediate|severe|life.?threaten/i.test(text)) return 'red';
    if (/delayed|moderate|stable but/i.test(text)) return 'yellow';
    if (/deceased|dead|no pulse|black tag/i.test(text)) return 'black';
    return 'green';
  }

  private inferActionsFromText(text: string, targetType: 'casualty' | 'hazard'): string[] {
    const actions: string[] = [];
    if (targetType === 'casualty') {
      if (/triage/i.test(text)) actions.push('Initiate Triage');
      if (/first aid|treat/i.test(text)) actions.push('Administer First Aid');
      if (/tourniquet|bleed/i.test(text)) actions.push('Apply Tourniquet');
      if (/iv|fluid/i.test(text)) actions.push('Establish IV Access');
      if (/assess/i.test(text)) actions.push('Assess Injuries');
      if (/stabiliz/i.test(text)) actions.push('Stabilize Patient');
      if (actions.length === 0) actions.push('Assess and Triage');
    } else {
      if (/contain/i.test(text)) actions.push('Deploy Containment');
      if (/suppress|extinguish/i.test(text)) actions.push('Fire Suppression');
      if (/foam|chemical/i.test(text)) actions.push('Deploy Foam/Agent');
      if (/decon/i.test(text)) actions.push('Establish Decon Corridor');
      if (/ventilat/i.test(text)) actions.push('Ventilation');
      if (actions.length === 0) actions.push('Assess and Contain');
    }
    return actions;
  }

  /**
   * When a bot writes a decision mentioning infrastructure (cordon, triage tent,
   * command post, etc.) but didn't include a placement action, parse the text
   * and auto-create the placement on the map.
   */
  private async tryExtractPlacementsFromDecision(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
  ): Promise<void> {
    const fullText = `${title} ${description}`.toLowerCase();
    const center = session.incidentCenter;
    if (!center) return;

    // Known infrastructure patterns → asset_type + geometry type
    const INFRASTRUCTURE_PATTERNS: Array<{
      pattern: RegExp;
      asset_type: string;
      geometry: 'point' | 'polygon';
      zoneOffset: 'hot' | 'warm' | 'cold';
      label: string;
    }> = [
      {
        pattern: /command\s*post/i,
        asset_type: 'command_post',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Command Post',
      },
      {
        pattern: /triage\s*(tent|point|area|station)/i,
        asset_type: 'triage_point',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Triage Point',
      },
      {
        pattern: /field\s*hospital/i,
        asset_type: 'field_hospital',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Field Hospital',
      },
      {
        pattern: /assembly\s*(point|area)/i,
        asset_type: 'assembly_point',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Assembly Point',
      },
      {
        pattern: /decon(tamination)?\s*(corridor|zone|area|station)/i,
        asset_type: 'decontamination_zone',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Decon Zone',
      },
      {
        pattern: /staging\s*(area|point|zone)/i,
        asset_type: 'staging_area',
        geometry: 'polygon',
        zoneOffset: 'cold',
        label: 'Staging Area',
      },
      {
        pattern: /inner\s*cordon/i,
        asset_type: 'inner_cordon',
        geometry: 'polygon',
        zoneOffset: 'hot',
        label: 'Inner Cordon',
      },
      {
        pattern: /outer\s*cordon/i,
        asset_type: 'outer_cordon',
        geometry: 'polygon',
        zoneOffset: 'cold',
        label: 'Outer Cordon',
      },
      {
        pattern: /media\s*(staging|area|point|zone)/i,
        asset_type: 'press_cordon',
        geometry: 'polygon',
        zoneOffset: 'cold',
        label: 'Media Staging Area',
      },
      {
        pattern: /hot\s*zone/i,
        asset_type: 'hot_zone',
        geometry: 'polygon',
        zoneOffset: 'hot',
        label: 'Hot Zone',
      },
      {
        pattern: /warm\s*zone/i,
        asset_type: 'warm_zone',
        geometry: 'polygon',
        zoneOffset: 'warm',
        label: 'Warm Zone',
      },
      {
        pattern: /cold\s*zone/i,
        asset_type: 'cold_zone',
        geometry: 'polygon',
        zoneOffset: 'cold',
        label: 'Cold Zone',
      },
      {
        pattern: /(?<!inner\s)(?<!outer\s)cordon\b/i,
        asset_type: 'outer_cordon',
        geometry: 'polygon',
        zoneOffset: 'cold',
        label: 'Security Cordon',
      },
      {
        pattern: /barricade|road\s*closure/i,
        asset_type: 'roadblock',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Barricade',
      },
      {
        pattern: /exclusion\s*zone|hazard\s*exclusion/i,
        asset_type: 'hot_zone',
        geometry: 'polygon',
        zoneOffset: 'hot',
        label: 'Exclusion Zone',
      },
      {
        pattern: /evacuation\s*(holding|point|area|assembly)/i,
        asset_type: 'assembly_point',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Evacuation Holding Area',
      },
      {
        pattern: /casualty\s*collection/i,
        asset_type: 'casualty_collection',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Casualty Collection Point',
      },
      {
        pattern: /observation\s*(post|point)/i,
        asset_type: 'observation_post',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Observation Post',
      },
      {
        pattern: /ambulance\s*(staging|bay|point)/i,
        asset_type: 'ambulance_staging',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Ambulance Staging',
      },
      {
        pattern: /helicopter\s*(lz|landing)/i,
        asset_type: 'helicopter_lz',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Helicopter LZ',
      },
      {
        pattern: /roadblock/i,
        asset_type: 'roadblock',
        geometry: 'point',
        zoneOffset: 'cold',
        label: 'Roadblock',
      },
      {
        pattern: /fire\s*(truck|engine|appliance)/i,
        asset_type: 'fire_truck',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Fire Engine',
      },
      {
        pattern: /forward\s*command/i,
        asset_type: 'forward_command',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Forward Command',
      },
      {
        pattern: /water\s*supply\s*(point)?/i,
        asset_type: 'water_supply',
        geometry: 'point',
        zoneOffset: 'warm',
        label: 'Water Supply Point',
      },
    ];

    // Check which infrastructure already exists on the map
    const { data: existingAssets } = await supabaseAdmin
      .from('placed_assets')
      .select('asset_type, label')
      .eq('session_id', session.sessionId)
      .eq('status', 'active');

    const existingTypes = new Set(
      (existingAssets ?? []).map((a) => (a as Record<string, unknown>).asset_type as string),
    );

    // Zone offsets from center (degrees)
    const ZONE_OFFSETS: Record<string, number> = {
      hot: 0.001,
      warm: 0.003,
      cold: 0.005,
    };

    // Try to extract coordinates from text (e.g., "[1.3045, 103.8367]" or "lat 1.3045, lng 103.8367")
    const coordMatches = Array.from(
      `${title} ${description}`.matchAll(/\[?\s*(-?\d+\.\d{3,})\s*[,\s]+\s*(-?\d+\.\d{3,})\s*\]?/g),
    );

    let placedCount = 0;

    for (const inf of INFRASTRUCTURE_PATTERNS) {
      if (!inf.pattern.test(fullText)) continue;
      if (existingTypes.has(inf.asset_type)) continue;
      if (!isPlacementAllowedForTeam(agent.persona.teamName, inf.asset_type)) continue;
      if (placedCount >= 2) break;

      // Try to use coordinates from the text first, otherwise generate from zone offsets
      let pointLat: number;
      let pointLng: number;

      if (coordMatches.length > placedCount) {
        const m = coordMatches[placedCount];
        const a = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        // Heuristic: latitude is usually smaller than longitude for most locations,
        // but we validate by checking proximity to the incident center
        const distALat = Math.abs(a - center.lat) + Math.abs(b - center.lng);
        const distBLat = Math.abs(b - center.lat) + Math.abs(a - center.lng);
        if (distALat < distBLat) {
          pointLat = a;
          pointLng = b;
        } else {
          pointLat = b;
          pointLng = a;
        }
        // Clamp to play area (within ~0.01 degrees of center)
        pointLat = Math.max(center.lat - 0.01, Math.min(center.lat + 0.01, pointLat));
        pointLng = Math.max(center.lng - 0.01, Math.min(center.lng + 0.01, pointLng));
      } else {
        const offset = ZONE_OFFSETS[inf.zoneOffset];
        const bearing = (placedCount * 90 + Math.random() * 30) * (Math.PI / 180);
        pointLat = center.lat + offset * Math.cos(bearing);
        pointLng = center.lng + offset * Math.sin(bearing);
      }

      let geometry: { type: string; coordinates: unknown };

      if (inf.geometry === 'point') {
        geometry = { type: 'Point', coordinates: [pointLng, pointLat] };
      } else {
        const size = inf.zoneOffset === 'hot' ? 0.002 : inf.zoneOffset === 'warm' ? 0.003 : 0.005;
        geometry = {
          type: 'Polygon',
          coordinates: [
            [
              [pointLng - size, pointLat - size],
              [pointLng + size, pointLat - size],
              [pointLng + size, pointLat + size],
              [pointLng - size, pointLat + size],
              [pointLng - size, pointLat - size],
            ],
          ],
        };
      }

      const label = `${agent.persona.teamName} ${inf.label}`;

      logger.info(
        { botUserId: agent.persona.botUserId, assetType: inf.asset_type, label },
        'AI agent: auto-creating placement from decision text (fallback)',
      );

      await this.dispatcher.createPlacement(session.sessionId, agent.persona.botUserId, {
        team_name: agent.persona.teamName,
        asset_type: inf.asset_type,
        label,
        geometry,
        properties: {},
      });

      existingTypes.add(inf.asset_type);
      placedCount++;
    }
  }

  /**
   * Programmatic round-robin exit claiming: load all exits, assign one per team,
   * then loop again until all exits are claimed or all teams have 2.
   */
  private async claimExitsRoundRobin(
    session: SessionAgents,
    agentEntries: Array<[string, AgentState]>,
  ): Promise<void> {
    const { data: allExits } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, location_type, pin_category')
      .eq('scenario_id', session.scenarioId)
      .in('pin_category', ['entry_exit']);

    const exitPins = (allExits ?? []) as Array<Record<string, unknown>>;
    if (exitPins.length === 0) {
      logger.info({ sessionId: session.sessionId }, 'No exits to claim in kickstart');
      return;
    }

    const teamClaimPurpose = (teamName: string): string => {
      const t = teamName.toLowerCase();
      if (t.includes('police') || t.includes('security') || t.includes('law'))
        return 'security_checkpoint';
      if (t.includes('evacuation') || t.includes('crowd') || t.includes('marshal'))
        return 'evacuation_exit';
      if (
        t.includes('medical') ||
        t.includes('ems') ||
        t.includes('triage') ||
        t.includes('ambulance')
      )
        return 'casualty_entry';
      if (t.includes('fire') || t.includes('hazmat') || t.includes('rescue'))
        return 'emergency_access';
      if (t.includes('media') || t.includes('press') || t.includes('pio')) return 'media_access';
      return 'operational_use';
    };

    const remainingExits = [...exitPins];
    const assignments: Array<{
      agent: AgentState;
      exitId: string;
      exitLabel: string;
      purpose: string;
    }> = [];
    const maxPerTeam = Math.max(1, Math.ceil(exitPins.length / agentEntries.length));

    const teamClaimCounts = new Map<string, number>();

    let round = 0;
    while (remainingExits.length > 0 && round < maxPerTeam) {
      for (const [, agentState] of agentEntries) {
        if (remainingExits.length === 0) break;
        const currentCount = teamClaimCounts.get(agentState.persona.teamName) || 0;
        if (currentCount > round) continue;

        const exit = remainingExits.shift()!;
        const purpose = teamClaimPurpose(agentState.persona.teamName);
        assignments.push({
          agent: agentState,
          exitId: exit.id as string,
          exitLabel: exit.label as string,
          purpose,
        });
        teamClaimCounts.set(agentState.persona.teamName, currentCount + 1);
      }
      round++;
    }

    let delay = KICKSTART_INITIAL_DELAY_MS;
    for (const { agent, exitId, exitLabel, purpose } of assignments) {
      const capturedDelay = delay;
      setTimeout(async () => {
        if (session.stopped) return;
        try {
          const claimed = await this.dispatcher.claimLocation(
            session.sessionId,
            exitId,
            agent.persona.teamName,
            purpose,
            'exclusive',
          );
          if (claimed) {
            const channelId = session.channelId;
            if (channelId) {
              await this.dispatcher.sendChatMessage(
                channelId,
                session.sessionId,
                agent.persona.botUserId,
                `${agent.persona.fullName} claiming ${exitLabel} as ${purpose.replace(/_/g, ' ')} for ${agent.persona.teamName}.`,
              );
            }
          }
        } catch (err) {
          logger.error(
            { error: err, exitId, team: agent.persona.teamName },
            'Kickstart exit claim failed',
          );
        }
      }, capturedDelay);
      delay += 3_000 + Math.random() * 2_000;
    }

    logger.info(
      {
        sessionId: session.sessionId,
        totalExits: exitPins.length,
        assignments: assignments.length,
      },
      'Kickstart: programmatic round-robin exit claiming scheduled',
    );
  }

  /**
   * Fallback: if a decision mentions claiming/securing exits but no claim action was included,
   * find matching exit locations and auto-claim them.
   */
  private async tryExtractClaimsFromDecision(
    session: SessionAgents,
    agent: AgentState,
    title: string,
    description: string,
  ): Promise<void> {
    const fullText = `${title} ${description}`.toLowerCase();

    // Only proceed if the text mentions claiming/securing/checkpoint
    if (!/(claim|secur|checkpoint|control|man(ning)?|assign|designat)\b/i.test(fullText)) {
      return;
    }

    // Fetch all claimable exits that haven't been claimed yet
    const { data: allExits } = await supabaseAdmin
      .from('scenario_locations')
      .select('id, label, pin_category')
      .eq('scenario_id', session.scenarioId);

    if (!allExits?.length) return;

    const exitPins = (allExits as Array<Record<string, unknown>>).filter(
      (l) => (l.pin_category as string) === 'entry_exit',
    );
    if (exitPins.length === 0) return;

    // Check existing claims
    const { data: existingClaims } = await supabaseAdmin
      .from('session_location_claims')
      .select('location_id')
      .eq('session_id', session.sessionId);
    const claimedIds = new Set(
      (existingClaims ?? []).map((c) => (c as Record<string, unknown>).location_id as string),
    );

    let claimedCount = 0;
    for (const exit of exitPins) {
      if (claimedCount >= 2) break;
      const exitId = exit.id as string;
      if (claimedIds.has(exitId)) continue;

      const exitLabel = ((exit.label as string) || '').toLowerCase();
      const exitWords = exitLabel.split(/[\s,/-]+/).filter((w) => w.length > 3);
      const matchScore = exitWords.filter((w) => fullText.includes(w)).length;

      if (matchScore >= 1) {
        logger.info(
          {
            botUserId: agent.persona.botUserId,
            exitLabel: exit.label,
            team: agent.persona.teamName,
          },
          'AI agent: auto-claiming exit from decision text (fallback)',
        );
        await this.dispatcher.claimLocation(
          session.sessionId,
          exitId,
          agent.persona.teamName,
          'security_checkpoint',
          'exclusive',
        );
        claimedCount++;
      }
    }
  }

  /**
   * Returns true if the given team should NOT be allowed to use pin_response
   * on the given target type. Uses the hardcoded TEAM_ALLOWED_PIN_TYPES map.
   */
  private isTeamBlockedFromPinResponse(teamName: string, targetType?: string): boolean {
    if (!targetType) return false;
    const t = teamName.toLowerCase();

    // These teams never interact with any pins directly
    if (
      t.includes('media') ||
      t.includes('press') ||
      t.includes('pio') ||
      t.includes('public information') ||
      t.includes('intelligence') ||
      t.includes('command') ||
      t.includes('coordinator')
    ) {
      return true;
    }

    // Check against the hardcoded allowed pin types
    for (const [key, allowedTypes] of Object.entries(TEAM_ALLOWED_PIN_TYPES)) {
      if (t.includes(key)) {
        return !allowedTypes.has(targetType);
      }
    }

    // Police/Security: no pin responses on casualties or hazards
    if (t.includes('police') || t.includes('security') || t.includes('law enforcement')) {
      return targetType === 'casualty' || targetType === 'hazard';
    }

    return false;
  }

  private async resolveLocationId(scenarioId: string, label: string): Promise<string | null> {
    try {
      // Strategy 1: exact ilike match
      const { data: exact } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label')
        .eq('scenario_id', scenarioId)
        .ilike('label', `%${label}%`)
        .limit(1);

      if (exact?.length) return (exact[0] as Record<string, unknown>).id as string;

      // Strategy 2: try each significant word in the label
      const words = label
        .split(/[\s,/-]+/)
        .filter((w) => w.length > 3)
        .map((w) => w.toLowerCase());

      if (words.length > 0) {
        const { data: allLocs } = await supabaseAdmin
          .from('scenario_locations')
          .select('id, label')
          .eq('scenario_id', scenarioId);

        if (allLocs?.length) {
          let bestMatch: string | null = null;
          let bestScore = 0;
          for (const loc of allLocs) {
            const locLabel = (
              ((loc as Record<string, unknown>).label as string) || ''
            ).toLowerCase();
            let score = 0;
            for (const w of words) {
              if (locLabel.includes(w)) score++;
            }
            if (score > bestScore) {
              bestScore = score;
              bestMatch = (loc as Record<string, unknown>).id as string;
            }
          }
          if (bestScore >= 1) return bestMatch;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Ground situation loader (casualties, hazards, claimable exits)
  // ---------------------------------------------------------------------------

  private async loadGroundSituation(
    sessionId: string,
    scenarioId: string,
  ): Promise<{
    casualties: string[];
    hazards: string[];
    claimableExits: Array<{
      label: string;
      location_type: string;
      claimStatus: string;
    }>;
  }> {
    const result = {
      casualties: [] as string[],
      hazards: [] as string[],
      claimableExits: [] as Array<{ label: string; location_type: string; claimStatus: string }>,
    };

    try {
      // Casualties (include ID so agents can target specific ones with pin_response)
      const { data: casualties } = await supabaseAdmin
        .from('scenario_casualties')
        .select(
          'id, casualty_type, headcount, status, location_lat, location_lng, conditions, player_triage_color, assigned_team',
        )
        .eq('session_id', sessionId)
        .in('status', [
          'undiscovered',
          'identified',
          'being_evacuated',
          'at_assembly',
          'endorsed_to_triage',
          'in_treatment',
        ])
        .limit(12);

      for (const c of (casualties ?? []) as Array<Record<string, unknown>>) {
        const conds = c.conditions as Record<string, unknown> | null;
        const condSummary = conds?.description || conds?.injury_type || '';
        const triageTag = c.player_triage_color ? `, triage: ${c.player_triage_color}` : '';
        const assigned = c.assigned_team ? `, assigned: ${c.assigned_team}` : '';
        result.casualties.push(
          `[id:${c.id}] ${c.casualty_type} (${c.headcount} people) at [${c.location_lat}, ${c.location_lng}] — status: ${c.status}${triageTag}${assigned}${condSummary ? `, ${condSummary}` : ''}`,
        );
      }

      // Hazards (include ID)
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select('id, hazard_type, status, location_lat, location_lng, properties')
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating'])
        .limit(8);

      for (const h of (hazards ?? []) as Array<Record<string, unknown>>) {
        const props = h.properties as Record<string, unknown> | null;
        const propSummary = props?.description || props?.size || '';
        result.hazards.push(
          `[id:${h.id}] ${h.hazard_type} at [${h.location_lat}, ${h.location_lng}] — ${h.status}${propSummary ? `, ${propSummary}` : ''}`,
        );
      }

      // Claimable exits
      const { data: exits } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label, location_type')
        .eq('scenario_id', scenarioId)
        .in('location_type', ['exit', 'entry', 'exit_entry', 'entry_exit'])
        .limit(15);

      if (exits && exits.length > 0) {
        const exitIds = (exits as Array<Record<string, unknown>>).map((e) => e.id as string);
        const { data: claims } = await supabaseAdmin
          .from('session_location_claims')
          .select('location_id, claimed_by_team, claimed_as')
          .eq('session_id', sessionId)
          .in('location_id', exitIds);

        const claimMap = new Map<string, { team: string; as: string }>();
        for (const cl of (claims ?? []) as Array<Record<string, unknown>>) {
          claimMap.set(cl.location_id as string, {
            team: cl.claimed_by_team as string,
            as: cl.claimed_as as string,
          });
        }

        for (const exit of exits as Array<Record<string, unknown>>) {
          const claim = claimMap.get(exit.id as string);
          result.claimableExits.push({
            label: exit.label as string,
            location_type: exit.location_type as string,
            claimStatus: claim
              ? `CLAIMED by ${claim.team} as ${claim.as}`
              : 'UNCLAIMED — available',
          });
        }
      }
    } catch (err) {
      logger.debug({ error: err, sessionId }, 'AI agent: failed to load ground situation');
    }

    return result;
  }

  private async loadRecentSessionActivity(sessionId: string): Promise<string[]> {
    const lines: string[] = [];
    try {
      const { data: decisions } = await supabaseAdmin
        .from('decisions')
        .select(
          'title, type, status, created_at, creator:user_profiles!decisions_proposed_by_fkey(full_name)',
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(8);

      for (const d of (decisions ?? []) as Array<Record<string, unknown>>) {
        const creator = d.creator as Record<string, unknown> | null;
        const name = (creator?.full_name as string) || 'Unknown';
        lines.push(`${name} — ${d.status}: "${d.title}"`);
      }

      const { data: placements } = await supabaseAdmin
        .from('placed_assets')
        .select(
          'asset_type, label, created_at, placed_by_profile:user_profiles!placed_assets_placed_by_fkey(full_name)',
        )
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(5);

      for (const p of (placements ?? []) as Array<Record<string, unknown>>) {
        const profile = p.placed_by_profile as Record<string, unknown> | null;
        const name = (profile?.full_name as string) || 'Unknown';
        lines.push(`${name} placed ${p.asset_type}: "${p.label}"`);
      }

      const { data: messages } = await supabaseAdmin
        .from('chat_messages')
        .select('content, created_at, sender:user_profiles!chat_messages_sender_id_fkey(full_name)')
        .eq('session_id', sessionId)
        .neq('type', 'system')
        .order('created_at', { ascending: false })
        .limit(5);

      for (const m of (messages ?? []) as Array<Record<string, unknown>>) {
        const sender = m.sender as Record<string, unknown> | null;
        const name = (sender?.full_name as string) || 'Unknown';
        lines.push(`${name} said: "${(m.content as string)?.slice(0, 100)}"`);
      }
    } catch (err) {
      logger.debug({ error: err, sessionId }, 'AI agent: failed to load recent activity');
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let agentServiceInstance: DemoAIAgentService | null = null;

export function getDemoAIAgentService(): DemoAIAgentService {
  if (!agentServiceInstance) {
    agentServiceInstance = new DemoAIAgentService();
  }
  return agentServiceInstance;
}
