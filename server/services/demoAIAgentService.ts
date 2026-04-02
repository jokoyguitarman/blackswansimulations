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
const AGENT_JITTER_BASE_MS = 12_000;
const AGENT_JITTER_RANGE_MS = 18_000;
const INTER_ACTION_BASE_MS = 5_000;
const INTER_ACTION_RANGE_MS = 5_000;
const HYBRID_DEFER_WINDOW_MS = 10_000;
const MAX_RECENT_ACTIONS = 15;
const AI_MODEL = 'gpt-4o-mini';
const PROACTIVE_INTERVAL_MS = 180_000; // 3 min between proactive ticks
const PROACTIVE_ACT_PROBABILITY = 0.15; // only 15% chance per agent per tick
const KICKSTART_STAGGER_MS = 25_000; // 25s between kickstart agents
const KICKSTART_INITIAL_DELAY_MS = 15_000;
const MAX_DECISIONS_PER_INJECT_CYCLE = 3; // max decisions across ALL agents before waiting for next inject
const INJECT_CYCLE_RESET_MS = 120_000; // auto-reset cycle budget after 2 min even without new inject

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
    const kickstartEvent: WebSocketEvent = {
      type: 'session.started',
      data: {
        message:
          'Exercise has begun. Check the exits/entries on the map and CLAIM the ones relevant to your team. Then make your initial situation assessment.',
      },
      timestamp: new Date().toISOString(),
    };

    // Kickstart is a fresh cycle
    session.cycleDecisionCount = 0;
    session.lastInjectTs = Date.now();

    for (let i = 0; i < agentEntries.length; i++) {
      const [, agentState] = agentEntries[i];
      const delay = KICKSTART_INITIAL_DELAY_MS + i * KICKSTART_STAGGER_MS + Math.random() * 8000;

      setTimeout(() => {
        if (session.stopped) return;
        if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) {
          logger.info(
            { botUserId: agentState.persona.botUserId },
            'AI agent: kickstart skipped, cycle budget used',
          );
          return;
        }
        agentState.lastActionTs = 0;
        this.generateAndExecuteActions(session, agentState, kickstartEvent).catch((err) => {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId },
            'AI agent kickstart failed',
          );
        });
      }, delay);
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

    // Only act with PROACTIVE_ACT_PROBABILITY chance
    if (Math.random() > PROACTIVE_ACT_PROBABILITY) return;

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

      const incidentCenter =
        scenario.center_lat != null && scenario.center_lng != null
          ? { lat: scenario.center_lat as number, lng: scenario.center_lng as number }
          : null;

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

        await this.executeSingleAction(session, agent, action);

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
      'Each turn you return EXACTLY 3 actions in this order:',
      '1. ONE consolidated DECISION (bundles everything you want to do this cycle)',
      '2. ONE PLACEMENT or ONE CLAIM (the most important map action from your decision)',
      '3. ONE short CHAT message (radio summary of what you just did)',
      '',
      '### DECISIONS (the only thing that counts)',
      'Decisions appear in the War Room panel and are scored. Placements/chat without a decision score ZERO.',
      '- title: Concise but specific (e.g. "Initial Containment: Inner Cordon + Triage Deployment")',
      '- description: 2-4 sentences bundling ALL tactical moves for this cycle. Reference locations, headcounts, procedures.',
      '',
      '### PLACEMENTS (visualize ONE key map action per decision)',
      'Each placement MUST use the correct geometry type for its asset:',
      '',
      'POINT assets (single location): command_post, triage_point, tactical_unit, helicopter_lz, roadblock, observation_post, casualty_collection, forward_command, medic, fire_truck, ambulance, decontamination_zone',
      '  → geometry: { "type": "Point", "coordinates": [lng, lat] }',
      '',
      'POLYGON assets (enclosed area perimeter): inner_cordon, outer_cordon, staging_area, press_cordon, hot_zone, warm_zone, cold_zone, assembly_area',
      '  → geometry: { "type": "Polygon", "coordinates": [[[lng1,lat1], [lng2,lat2], [lng3,lat3], [lng4,lat4], [lng1,lat1]]] }',
      '  → MUST be a closed ring (first and last coordinate identical), minimum 4 corners',
      '',
      'LINESTRING assets (route/path): evacuation_route, patrol_route, supply_route',
      '  → geometry: { "type": "LineString", "coordinates": [[lng1,lat1], [lng2,lat2], [lng3,lat3]] }',
      '  → Minimum 2 waypoints, ideally 3-5 for realistic curves',
    );

    if (session.incidentCenter) {
      const { lat, lng } = session.incidentCenter;
      parts.push(
        '',
        `- Incident center: [${lat}, ${lng}]. All coordinates MUST be real map coordinates near this center.`,
        `- For POINTS: use the center ± small offsets (0.0005 to 0.003).`,
        `- For POLYGONS: create a ring around the target area. Example inner cordon around incident center:`,
        `  { "type": "Polygon", "coordinates": [[[${(lng - 0.002).toFixed(4)},${(lat - 0.002).toFixed(4)}], [${(lng + 0.002).toFixed(4)},${(lat - 0.002).toFixed(4)}], [${(lng + 0.002).toFixed(4)},${(lat + 0.002).toFixed(4)}], [${(lng - 0.002).toFixed(4)},${(lat + 0.002).toFixed(4)}], [${(lng - 0.002).toFixed(4)},${(lat - 0.002).toFixed(4)}]]] }`,
        `- For outer cordon, use a LARGER polygon (± 0.004 to 0.006 from center).`,
        `- For LINESTRINGS: connect known locations. Example evacuation route:`,
        `  { "type": "LineString", "coordinates": [[${(lng - 0.001).toFixed(4)},${(lat + 0.001).toFixed(4)}], [${(lng + 0.002).toFixed(4)},${(lat + 0.003).toFixed(4)}]] }`,
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
        );
        break;
      case 'advanced':
        parts.push(
          'You are an ADVANCED EXPERT responder with deep operational and game-mechanics knowledge.',
          'You play like a seasoned crisis management professional who understands every nuance of the system.',
          '',
          '### Zone Architecture (MANDATORY for expert play)',
          '- You MUST establish 3 concentric zone polygons early: HOT ZONE (innermost, immediate danger area around the incident), WARM ZONE (buffer/decontamination/triage staging), COLD ZONE (outermost, safe area for command post, media, logistics).',
          '- The HOT zone polygon should tightly surround the incident and known hazards.',
          '- The WARM zone polygon should be larger, encompassing triage points, decon corridors, and casualty collection areas.',
          '- The COLD zone polygon should be the outermost perimeter, containing assembly points, command post, and media staging.',
          '- Every casualty and hazard pin should be INSIDE a zone polygon. Pins outside any zone are operationally unsecured.',
          '',
          '### Cordon & Security Layers',
          '- INNER CORDON: a polygon tightly around the hot zone. Only authorized responders enter. Place this BEFORE entering the hot zone.',
          '- OUTER CORDON: a wider polygon around the entire scene. Controls public access. Place this to keep civilians, media, and bystanders out.',
          '- Cordons should be drawn BEFORE operations begin inside them. You do NOT enter an unsecured hot zone.',
          '- Every operational area (triage tent, decon zone, field hospital) should be placed INSIDE the appropriate zone polygon.',
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
          '### Operational Sequencing (expert knows the correct order)',
          '1. FIRST: Establish outer cordon and claim exits → scene security before anything else.',
          '2. SECOND: Draw hot/warm/cold zone polygons → define the operational geography.',
          '3. THIRD: Deploy inner cordon around hot zone → secure the danger area.',
          '4. FOURTH: Place triage tent/field hospital inside warm zone → create treatment infrastructure.',
          '5. FIFTH: Begin triage with pin_response, one casualty at a time → systematic patient care.',
          '6. SIXTH: Extract patients from hot zone to warm zone with proper equipment → specify stretchers, splints.',
          '7. SEVENTH: Treat patients at triage point → administer care based on triage color.',
          '8. EIGHTH: Transport treated patients to hospital → only after treatment, with named facility and vehicle.',
          '9. THROUGHOUT: Contain and mitigate hazards before they escalate → fire suppression, chemical containment.',
          '',
          '### Spatial Awareness',
          '- Every decision should reference WHERE on the map the action is happening.',
          '- When placing a triage tent, put it in the warm zone, near an exit for efficient patient flow.',
          '- When placing an assembly point, put it in the cold zone, away from hazards.',
          '- Evacuation routes (LineString) should connect the incident area through exits to assembly points.',
          '- Do NOT place triage inside the hot zone — it is dangerous and operationally incorrect.',
          '',
          '### Coordination & Communication',
          '- Reference what other teams have done and build on their work.',
          '- When fire team contains a hazard, medical team can then safely enter to extract casualties.',
          '- When police secures a cordon, evacuation team can begin directing crowds through safe exits.',
          '- Use proper radio protocol: state your team, your action, your location, your resource request.',
          '',
          '### Expert Decision Quality',
          '- Your decisions are always OPERATIONALLY SPECIFIC: exact locations, personnel counts, equipment lists, procedure names.',
          '- You reference sector standards and doctrines by name.',
          '- You check environmental conditions and hazard status before committing resources.',
          '- Virtually all your decisions should be sound, well-formed, and actionable.',
          '- You respond to ALL environmental truths: insider knowledge, hazard properties, casualty conditions.',
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

    // Ground situation: casualties, hazards, claimable exits
    const ground = await this.loadGroundSituation(session.sessionId, session.scenarioId);

    if (ground.claimableExits.length > 0) {
      parts.push('', '## Claimable Exits & Entries (claim before others take them!):');
      for (const exit of ground.claimableExits) {
        parts.push(`- "${exit.label}" (${exit.location_type}) — ${exit.claimStatus}`);
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

      // Hazard detailed properties
      const { data: hazards } = await supabaseAdmin
        .from('scenario_hazards')
        .select('hazard_type, status, properties, resolution_requirements')
        .eq('session_id', sessionId)
        .in('status', ['active', 'escalating', 'contained'])
        .limit(8);

      if (hazards && hazards.length > 0) {
        sections.push('', '## 🔬 HAZARD DETAILS (full environmental truth):');
        for (const h of hazards as Array<Record<string, unknown>>) {
          const props = h.properties as Record<string, unknown> | null;
          const reqs = h.resolution_requirements as Record<string, unknown> | null;
          const details = [
            `Type: ${h.hazard_type}, Status: ${h.status}`,
            props ? `Properties: ${JSON.stringify(props)}` : '',
            reqs ? `Resolution requires: ${JSON.stringify(reqs)}` : '',
          ]
            .filter(Boolean)
            .join('. ');
          sections.push(`- ${details}`);
        }
      }

      // Casualty detailed conditions
      const { data: casualties } = await supabaseAdmin
        .from('scenario_casualties')
        .select(
          'casualty_type, headcount, status, conditions, treatment_requirements, transport_prerequisites',
        )
        .eq('session_id', sessionId)
        .in('status', ['undiscovered', 'identified', 'endorsed_to_triage', 'in_treatment'])
        .limit(10);

      if (casualties && casualties.length > 0) {
        sections.push('', '## 🏥 CASUALTY MEDICAL DETAILS (full clinical truth):');
        for (const c of casualties as Array<Record<string, unknown>>) {
          const conds = c.conditions as Record<string, unknown> | null;
          const treatReqs = c.treatment_requirements as Record<string, unknown> | null;
          const transReqs = c.transport_prerequisites as Record<string, unknown> | null;
          const details = [
            `${c.casualty_type} (${c.headcount}), status: ${c.status}`,
            conds ? `Conditions: ${JSON.stringify(conds)}` : '',
            treatReqs ? `Treatment required: ${JSON.stringify(treatReqs)}` : '',
            transReqs ? `Transport prerequisites: ${JSON.stringify(transReqs)}` : '',
          ]
            .filter(Boolean)
            .join('. ');
          sections.push(`- ${details}`);
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
        '- NEVER send medical teams into the hot zone until YOU confirm it is safe — this is YOUR responsibility',
        '- Check wind direction before positioning (upwind approach for HAZMAT)',
        '- If there are casualties inside the hot zone, YOU extract them to the warm zone boundary — then medical takes over',
        '- Structural assessment before entry — if building is compromised, request structural engineer before sending crews in',
        '- Establish a water supply point and specify hydrant location or tanker',
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
        '- Request specific specialist resources: "2 paramedics with ALS capability" not just "medical team"',
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
          max_tokens: 900,
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
  ): Promise<void> {
    const { sessionId, channelId } = session;
    const { botUserId, teamName } = agent.persona;

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
        );
        if (converted) {
          logger.info(
            { botUserId, targetId: converted.target_id, targetType: converted.target_type },
            'AI agent: auto-converted decision to pin_response (decision text referenced a pin)',
          );
          await this.dispatcher.respondToPin(sessionId, botUserId, teamName, converted);
          break;
        }

        await this.dispatcher.proposeAndExecuteDecision(sessionId, botUserId, {
          title: action.decision.title,
          description: action.decision.description,
        });
        break;
      }

      case 'placement': {
        if (!action.placement) break;
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
        const pr = action.pin_response;
        logger.info(
          { botUserId, targetId: pr.target_id, targetType: pr.target_type, label: pr.target_label },
          'AI agent: executing pin_response',
        );
        await this.dispatcher.respondToPin(sessionId, botUserId, teamName, {
          target_id: pr.target_id,
          target_type: pr.target_type,
          target_label: pr.target_label || 'Unknown target',
          actions: pr.actions || [],
          resources: pr.resources || [],
          triage_color: pr.triage_color,
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
    if (now - agent.lastActionTs < AGENT_THROTTLE_MS) return false;
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
    if (!center) return geometry;

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
    return geometry;
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

    // Also detect keyword-based references to casualties/hazards without UUIDs
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

  private async resolveLocationId(scenarioId: string, label: string): Promise<string | null> {
    try {
      const { data } = await supabaseAdmin
        .from('scenario_locations')
        .select('id, label')
        .eq('scenario_id', scenarioId)
        .ilike('label', `%${label}%`)
        .limit(1)
        .single();
      return (data as Record<string, unknown>)?.id as string | null;
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
