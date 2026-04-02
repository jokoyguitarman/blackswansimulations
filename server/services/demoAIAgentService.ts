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
}

interface SingleAction {
  action: 'decision' | 'placement' | 'chat' | 'none';
  decision?: { title: string; description: string; decision_type?: string };
  placement?: {
    asset_type: string;
    label: string;
    geometry: { type: string; coordinates: unknown };
    properties?: Record<string, unknown>;
  };
  chat?: { content: string };
}

interface AgentMultiResponse {
  actions: SingleAction[];
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_THROTTLE_MS = 20_000;
const AGENT_RESPONSE_JITTER_MS = 4_000;
const HYBRID_DEFER_WINDOW_MS = 8_000;
const MAX_RECENT_ACTIONS = 15;
const AI_MODEL = 'gpt-4o-mini';
const PROACTIVE_INTERVAL_MS = 45_000;
const PROACTIVE_ACT_PROBABILITY = 0.4;
const KICKSTART_STAGGER_MS = 5_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DemoAIAgentService {
  private sessions = new Map<string, SessionAgents>();
  private dispatcher = new DemoActionDispatcher();

  /**
   * Spin up AI agents for every team in a session.
   * Call this after the session and bot participants are created.
   */
  async start(
    sessionId: string,
    scenarioId: string,
    options?: {
      scriptAware?: boolean;
    },
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
    };

    for (const team of context.teams) {
      const botUserId = resolveBotUserId(team.team_name);
      const profile = await this.loadBotProfile(botUserId);

      const persona: AgentPersona = {
        botUserId,
        teamName: team.team_name,
        fullName: profile?.full_name || team.team_name,
        roleName: profile?.role || team.team_name,
        agencyName: profile?.agency_name || team.team_name,
        teamDescription: team.description || '',
        doctrines: team.doctrines || '',
      };

      session.agents.set(botUserId, {
        persona,
        recentActions: [],
        lastActionTs: 0,
        pendingCooldown: false,
      });
    }

    // Wire up WebSocket event listeners
    const handler: InternalEventHandler = (event) => {
      if (session.stopped) return;
      this.handleSessionEvent(session, event).catch((err) => {
        logger.error(
          { error: err, sessionId, eventType: event.type },
          'AI agent event handling error',
        );
      });
    };
    session.eventHandler = handler;
    getWebSocketService().onSessionEvent(sessionId, handler);

    if (channelId) {
      const chHandler: InternalEventHandler = (event) => {
        if (session.stopped) return;
        this.handleChannelEvent(session, event).catch((err) => {
          logger.error(
            { error: err, sessionId, eventType: event.type },
            'AI agent channel event error',
          );
        });
      };
      session.channelHandlers.set(channelId, chHandler);
      getWebSocketService().onChannelEvent(channelId, chHandler);
    }

    this.sessions.set(sessionId, session);

    logger.info({ sessionId, scenarioId, agentCount: session.agents.size }, 'AI agents started');

    // Kickstart: stagger initial actions so each agent makes opening moves
    this.runKickstart(session);

    // Proactive timer: agents periodically re-evaluate the situation
    session.proactiveTimer = setInterval(() => {
      if (session.stopped) return;
      this.proactiveTick(session).catch((err) => {
        logger.error({ error: err, sessionId }, 'AI agent proactive tick error');
      });
    }, PROACTIVE_INTERVAL_MS);

    return true;
  }

  /**
   * Stop all AI agents for a session and detach listeners.
   */
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
          'Exercise has begun. Perform your initial situation assessment and opening actions.',
      },
      timestamp: new Date().toISOString(),
    };

    for (let i = 0; i < agentEntries.length; i++) {
      const [, agentState] = agentEntries[i];
      const delay = (i + 1) * KICKSTART_STAGGER_MS + Math.random() * 3000;

      setTimeout(() => {
        if (session.stopped) return;
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

    const elapsed = this.getElapsedMinutes(session);
    const proactiveEvent: WebSocketEvent = {
      type: 'proactive.tick',
      data: {
        message: `${Math.floor(elapsed)} minutes into the exercise. Assess the current situation and take your next actions.`,
        elapsed_minutes: Math.floor(elapsed),
      },
      timestamp: new Date().toISOString(),
    };

    for (const [, agentState] of session.agents) {
      if (!this.canAct(agentState, session)) continue;
      if (Math.random() > PROACTIVE_ACT_PROBABILITY) continue;

      const jitter = Math.random() * AGENT_RESPONSE_JITTER_MS;
      setTimeout(() => {
        if (session.stopped) return;
        this.generateAndExecuteActions(session, agentState, proactiveEvent).catch((err) => {
          logger.error(
            { error: err, botUserId: agentState.persona.botUserId },
            'AI agent proactive action failed',
          );
        });
      }, jitter);
    }
  }

  // ---------------------------------------------------------------------------
  // Scenario context loader
  // ---------------------------------------------------------------------------

  private async loadScenarioContext(scenarioId: string): Promise<{
    scenarioSummary: string;
    sectorStandards: string;
    incidentCenter: { lat: number; lng: number } | null;
    teams: Array<{
      team_name: string;
      description: string;
      doctrines: string;
    }>;
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
    const triggerTypes = [
      'inject.published',
      'decision.executed',
      'state.updated',
      'placement.created',
    ];

    if (!triggerTypes.includes(event.type)) return;

    const originatorId = this.extractOriginatorId(event);

    for (const [botUserId, agentState] of session.agents) {
      if (originatorId === botUserId) continue;
      if (!this.canAct(agentState, session)) continue;

      const jitter = Math.random() * AGENT_RESPONSE_JITTER_MS + 2000;
      setTimeout(() => {
        if (session.stopped) return;
        this.generateAndExecuteActions(session, agentState, event).catch((err) => {
          logger.error({ error: err, botUserId, eventType: event.type }, 'AI agent action failed');
        });
      }, jitter);
    }
  }

  private async handleChannelEvent(session: SessionAgents, event: WebSocketEvent): Promise<void> {
    if (event.type !== 'message.sent') return;

    const msg = event.data.message as Record<string, unknown> | undefined;
    const senderId =
      (msg?.sender_id as string) || ((msg?.sender as Record<string, unknown>)?.id as string);
    if (!senderId) return;

    for (const [botUserId, agentState] of session.agents) {
      if (senderId === botUserId) continue;
      if (!this.canAct(agentState, session)) continue;
      if (Math.random() > 0.35) continue;

      const jitter = Math.random() * AGENT_RESPONSE_JITTER_MS + 3000;
      setTimeout(() => {
        if (session.stopped) return;
        this.generateAndExecuteActions(session, agentState, event).catch((err) => {
          logger.error({ error: err, botUserId }, 'AI agent chat response failed');
        });
      }, jitter);
    }
  }

  // ---------------------------------------------------------------------------
  // Core AI response generation (multi-action)
  // ---------------------------------------------------------------------------

  private async generateAndExecuteActions(
    session: SessionAgents,
    agent: AgentState,
    triggerEvent: WebSocketEvent,
  ): Promise<void> {
    if (session.stopped) return;
    if (!this.canAct(agent, session)) return;

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

      for (const action of actions.slice(0, 4)) {
        if (session.stopped) break;
        await this.executeSingleAction(session, agent, action);

        const label =
          action.action === 'decision'
            ? `decision: ${action.decision?.title || ''}`
            : action.action === 'placement'
              ? `placement: ${action.placement?.asset_type} "${action.placement?.label}"`
              : action.action === 'chat'
                ? `chat: ${action.chat?.content?.slice(0, 80) || ''}`
                : action.action;

        agent.recentActions.push(`[${new Date().toISOString()}] ${label}`.slice(0, 200));

        if (actions.indexOf(action) < actions.length - 1) {
          await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
        }
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
      `You are ${persona.fullName}, ${persona.agencyName}, assigned to team "${persona.teamName}" in a live multi-agency crisis management exercise on the Black Swan Simulations platform.`,
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

    // Game mechanics explanation
    parts.push(
      '',
      '## How This Exercise Works',
      '',
      'You interact through THREE action types. Return MULTIPLE actions per turn (2-4 is ideal).',
      '',
      '### 1. DECISIONS (Most Important!)',
      'Decisions are the PRIMARY game mechanic. Every significant action must be recorded as a decision. They appear in the War Room decisions panel, are evaluated against objectives, and drive the exercise forward.',
      '- title: Concise action title (e.g. "Establish Inner Cordon - 200m radius from blast site")',
      '- description: Detailed explanation — what, why, resources needed, expected outcome. Reference specific locations, procedures, and standards. Vague decisions score poorly.',
      '- decision_type: containment | tactical_deployment | resource_request | communication | medical_response | evacuation | investigation | public_information | negotiation | hazmat_response',
      '',
      'Good: title="Deploy Forward Triage at Assembly North", description="Establishing START triage 150m from blast in upwind direction. Two paramedic teams assigned. P1 routed to SGH via Penang Rd. Requesting 4 additional ambulances."',
      'Bad: title="Set up triage", description="We should do triage somewhere"',
      '',
      '### 2. PLACEMENTS (Support Decisions with Map Actions)',
      'Drop tactical assets on the map to visualize your decisions. Always pair with a related decision.',
      '- asset_type: command_post | inner_cordon | outer_cordon | staging_area | triage_point | evacuation_route | sniper_position | tactical_unit | press_cordon | decontamination_zone | helicopter_lz | roadblock | observation_post | casualty_collection | forward_command | water_point | rest_area',
      '- label: Human-readable label',
      '- geometry: GeoJSON — Point for assets, LineString for cordons/routes, Polygon for zones',
    );

    if (session.incidentCenter) {
      const { lat, lng } = session.incidentCenter;
      parts.push(
        '',
        `Incident center is at [${lat}, ${lng}]. Use REAL coordinates near this point:`,
        `- Inner cordon: ±0.001–0.002 offset (~100-200m)`,
        `- Outer cordon: ±0.003–0.005 offset (~300-500m)`,
        `- Staging/triage: ±0.002–0.004 offset, on accessible side`,
        `- Command post: ±0.003–0.005 offset, clear sightline`,
        `Example Point: [${lng + 0.002}, ${lat - 0.001}]`,
        `Example LineString: [[${lng - 0.002}, ${lat + 0.002}], [${lng + 0.002}, ${lat + 0.002}], [${lng + 0.002}, ${lat - 0.002}]]`,
      );
    }

    parts.push(
      '',
      '### 3. CHAT (Radio Communications)',
      'Short professional radio-style messages to coordinate with other teams. Use call signs and tactical language.',
      'Example: "All stations, Police Actual. Inner cordon set 200m from epicenter. Orchard Rd and Penang Rd blocked. Request EMS staging at Assembly North. Over."',
      '',
      '## Response Format',
      'Return a JSON object with an array of 2-4 actions:',
      '```json',
      '{',
      '  "actions": [',
      '    { "action": "decision", "decision": { "title": "...", "description": "...", "decision_type": "..." } },',
      '    { "action": "placement", "placement": { "asset_type": "...", "label": "...", "geometry": { "type": "Point", "coordinates": [lng, lat] } } },',
      '    { "action": "chat", "chat": { "content": "..." } }',
      '  ],',
      '  "reasoning": "Brief tactical thinking"',
      '}',
      '```',
      '',
      '## Tactical Behavior by Phase',
      '- Minutes 0-3: Situation assessment, initial containment, establish command post, request SITREP',
      '- Minutes 3-8: Deploy cordons, establish triage, coordinate with agencies, first resource requests',
      '- Minutes 8-15: Tactical response, specialist deployments, evacuation, media management',
      '- Minutes 15+: Sustained operations, resource rotation, investigation, recovery planning',
      '',
      '## Rules',
      '- Prioritize DECISIONS — they are how performance is measured',
      '- Pair placements with decisions that explain them',
      '- Reference specific locations, routes, and standards',
      "- Acknowledge other teams' actions in chat",
      '- Do NOT repeat actions already taken',
      '- Escalate appropriately as new injects arrive',
    );

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

    // What triggered this turn
    if (event.type === 'session.started' || event.type === 'proactive.tick') {
      parts.push(`Trigger: ${event.data.message || 'Periodic situation reassessment'}`);
    } else {
      parts.push(`New event: ${event.type}`);
      parts.push(JSON.stringify(event.data, null, 2).slice(0, 1500));
    }

    // Recent session activity from other teams
    const recentActivity = await this.loadRecentSessionActivity(session.sessionId);
    if (recentActivity.length > 0) {
      parts.push('', '## Recent actions by all teams:');
      for (const act of recentActivity.slice(0, 10)) {
        parts.push(`- ${act}`);
      }
    }

    if (agent.recentActions.length > 0) {
      parts.push('', '## Your previous actions (do not repeat):');
      for (const action of agent.recentActions.slice(-8)) {
        parts.push(`- ${action}`);
      }
    }

    parts.push('', 'What are your next actions? Return 2-4 actions as JSON. Prioritize decisions.');

    return parts.join('\n');
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
          max_tokens: 1200,
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

      // Support both { actions: [...] } and legacy single-action { action: "..." }
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
          decision_type: action.decision.decision_type,
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

  /**
   * If the AI returns coordinates that are near [0,0] (i.e. offsets),
   * translate them relative to the incident center.
   */
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
          Array.isArray(rings[0]) &&
          rings[0].length > 0 &&
          isNearOrigin(rings[0][0])
        ) {
          return {
            type: 'Polygon',
            coordinates: rings.map((ring) => ring.map(translate)),
          };
        }
      }
    } catch {
      // geometry is already absolute or malformed — return as-is
    }

    return geometry;
  }

  /**
   * Load recent decisions and placements to give agents awareness of what
   * other teams have done.
   */
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
        .limit(6);

      for (const p of (placements ?? []) as Array<Record<string, unknown>>) {
        const profile = p.placed_by_profile as Record<string, unknown> | null;
        const name = (profile?.full_name as string) || 'Unknown';
        lines.push(`${name} placed ${p.asset_type}: "${p.label}"`);
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
