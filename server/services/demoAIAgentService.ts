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

    // Stagger agent responses to the inject
    const agentEntries = Array.from(session.agents.entries());
    for (let i = 0; i < agentEntries.length; i++) {
      const [, agentState] = agentEntries[i];
      if (!this.canAct(agentState, session)) continue;

      const delay =
        AGENT_JITTER_BASE_MS + i * KICKSTART_STAGGER_MS + Math.random() * AGENT_JITTER_RANGE_MS;
      setTimeout(() => {
        if (session.stopped) return;
        if (session.cycleDecisionCount >= MAX_DECISIONS_PER_INJECT_CYCLE) return;
        if (agentState.actedThisCycle) return;
        this.generateAndExecuteActions(session, agentState, event).catch((err) => {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId, eventType: event.type },
            'AI agent action failed',
          );
        });
      }, delay);
    }
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
      'Use pin_response INSTEAD of a regular decision when you want to directly triage a casualty or mitigate a hazard.',
      '- target_id: the exact ID from the casualties/hazards list (e.g. "abc-123...")',
      '- target_type: "casualty" or "hazard"',
      '- target_label: human-readable name (e.g. "Burn victims near Gate B")',
      '- actions: array of action labels you are taking (e.g. ["Initiate Triage", "Administer First Aid"])',
      '- resources: array of resources deployed (e.g. [{ "type": "medic", "label": "Paramedic Team", "quantity": 2 }])',
      '- triage_color: for casualties only — "green", "yellow", "red", or "black"',
      '- description: brief description of what you are doing',
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
      '- Minutes 3-8: Deploy cordons/triage. Use PIN_RESPONSE to triage casualties one by one and address hazards.',
      '- Minutes 8-15: Continue pin responses for remaining casualties. Specialist deployments, evacuations, hazard mitigation.',
      '- Minutes 15+: Sustained ops, resource rotation, investigation, recovery.',
      '',
      '## CRITICAL Rules',
      '- Every turn MUST have exactly 1 decision (or 1 pin_response) + 1 placement/claim + 1 chat.',
      '- Use pin_response when there are untagged casualties or active hazards you can address. Otherwise use a regular decision.',
      '- Bundle ALL your tactical moves into ONE decision with a rich description.',
      '- NEVER place an inner_cordon or outer_cordon if one already exists.',
      '- READ "Recent actions" and "Ground situation" carefully. Address SPECIFIC casualties and hazards by name/location.',
      '- Focus on YOUR team specialty. Do not duplicate what other teams already did.',
      '- Each decision must be UNIQUE — never repeat a previous decision.',
      '- If the situation is stable and nothing new requires action, return { "actions": [{ "action": "none" }] }.',
      '- You are NOT expected to act every time. Real professionals wait, observe, and only act when there is something meaningful to address.',
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
          'You are an ADVANCED expert responder with deep operational knowledge:',
          '- Your decisions are always OPERATIONALLY SPECIFIC: exact locations, personnel counts, equipment lists, procedure names.',
          '- You ALWAYS place the correct map asset when establishing infrastructure (triage_point when setting up triage, inner_cordon polygon when establishing perimeter, etc.).',
          '- You reference the sector standards and doctrines by name in your decisions.',
          '- You check environmental conditions and hazard status before making decisions.',
          '- You draw appropriately-sized cordons (inner tighter, outer wider) using Polygon geometry.',
          '- You coordinate with other teams, acknowledge their actions, and avoid jurisdiction overlap.',
          '- You triage casualties methodically using proper triage protocols (START/SALT).',
          '- You respond to ALL environmental truths: available insider knowledge, hazard properties, casualty conditions.',
          '- Your polygons and linestrings are realistic in shape and size.',
          '- Virtually all your decisions should be sound and well-formed.',
        );
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
        .in('status', ['active', 'escalating', 'being_mitigated'])
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
        if (!action.pin_response?.target_id) break;
        const pr = action.pin_response;
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
