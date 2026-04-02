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
  agents: Map<string, AgentState>;
  channelId: string | null;
  eventHandler: InternalEventHandler;
  channelHandlers: Map<string, InternalEventHandler>;
  scriptAware: boolean;
  scriptNextEventTs: number;
  stopped: boolean;
}

type AgentActionType = 'decision' | 'placement' | 'chat' | 'none';

interface AgentActionResponse {
  action: AgentActionType;
  decision?: { title: string; description: string; decision_type?: string };
  placement?: {
    asset_type: string;
    label: string;
    geometry: { type: string; coordinates: unknown };
    properties?: Record<string, unknown>;
  };
  chat?: { content: string };
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_THROTTLE_MS = 12_000;
const AGENT_RESPONSE_JITTER_MS = 4_000;
const HYBRID_DEFER_WINDOW_MS = 8_000;
const MAX_RECENT_ACTIONS = 12;
const AI_MODEL = 'gpt-4o-mini';

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
      agents: new Map(),
      channelId,
      eventHandler: () => {},
      channelHandlers: new Map(),
      scriptAware: options?.scriptAware ?? false,
      scriptNextEventTs: 0,
      stopped: false,
    };

    for (const team of context.teams) {
      const botUserId = resolveBotUserId(team.team_name);
      const persona: AgentPersona = {
        botUserId,
        teamName: team.team_name,
        roleName: team.team_name,
        agencyName: team.team_name,
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

    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'AI agents stopped');
  }

  /**
   * Inform the agent service that a scripted event is about to fire.
   * Used in hybrid mode so agents defer.
   */
  notifyUpcomingScriptEvent(sessionId: string, firesAtMs: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.scriptNextEventTs = firesAtMs;
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Scenario context loader
  // ---------------------------------------------------------------------------

  private async loadScenarioContext(scenarioId: string): Promise<{
    scenarioSummary: string;
    sectorStandards: string;
    teams: Array<{
      team_name: string;
      description: string;
      doctrines: string;
    }>;
  } | null> {
    try {
      const { data: scenario } = await supabaseAdmin
        .from('scenarios')
        .select('id, title, description, scenario_type, center_lat, center_lng, insider_knowledge')
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
        .select('name, type, description')
        .eq('scenario_id', scenarioId)
        .limit(10);

      const locationSummary = (locations ?? [])
        .map((l: Record<string, unknown>) => `- ${l.name} (${l.type}): ${l.description || ''}`)
        .join('\n');

      const scenarioSummary = [
        `Title: ${scenario.title}`,
        `Type: ${scenario.scenario_type || 'general'}`,
        scenario.description ? `Description: ${scenario.description}` : '',
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

      return { scenarioSummary, sectorStandards, teams: teamList };
    } catch (err) {
      logger.error({ error: err, scenarioId }, 'AI agents: failed to load scenario context');
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
        this.generateAndExecuteAction(session, agentState, event).catch((err) => {
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
        this.generateAndExecuteAction(session, agentState, event).catch((err) => {
          logger.error({ error: err, botUserId }, 'AI agent chat response failed');
        });
      }, jitter);
    }
  }

  // ---------------------------------------------------------------------------
  // Core AI response generation
  // ---------------------------------------------------------------------------

  private async generateAndExecuteAction(
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
      const userPrompt = this.buildUserPrompt(agent, triggerEvent);

      const aiResponse = await this.callOpenAI(systemPrompt, userPrompt);
      if (!aiResponse || aiResponse.action === 'none') {
        agent.pendingCooldown = false;
        return;
      }

      await this.executeAgentAction(session, agent, aiResponse);

      agent.recentActions.push(
        `[${new Date().toISOString()}] ${aiResponse.action}: ${aiResponse.reasoning || ''}`.slice(
          0,
          200,
        ),
      );
      if (agent.recentActions.length > MAX_RECENT_ACTIONS) {
        agent.recentActions.shift();
      }
    } finally {
      agent.pendingCooldown = false;
    }
  }

  private buildSystemPrompt(session: SessionAgents, agent: AgentState): string {
    const { persona } = agent;
    const parts: string[] = [
      `You are an AI agent playing the role of "${persona.roleName}" from "${persona.agencyName}" (team: ${persona.teamName}) in a live multi-agency crisis management exercise.`,
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
      '## Instructions',
      '- Respond ONLY with a JSON object matching the schema below.',
      '- Choose "none" if no action is warranted right now.',
      '- Decisions should be realistic, specific, and reference real tactical procedures.',
      '- Placements must use GeoJSON (Point, LineString, or Polygon). Use small offsets from [0,0] — the system translates coordinates.',
      '- Chat messages should be short, professional radio-style comms.',
      '- Do NOT repeat actions you have already taken. Be creative and escalate appropriately.',
      '- Think about timing: early in the incident focus on containment and assessment; later focus on resolution and recovery.',
      '',
      '## Response Schema',
      '```json',
      '{',
      '  "action": "decision" | "placement" | "chat" | "none",',
      '  "reasoning": "brief explanation of why this action",',
      '  "decision": { "title": "...", "description": "...", "decision_type": "..." },',
      '  "placement": { "asset_type": "...", "label": "...", "geometry": { "type": "Point|LineString|Polygon", "coordinates": [...] } },',
      '  "chat": { "content": "..." }',
      '}',
      '```',
      '',
      'Valid asset_types: command_post, inner_cordon, outer_cordon, staging_area, triage_point, evacuation_route, sniper_position, tactical_unit, press_cordon, decontamination_zone, helicopter_lz, roadblock, observation_post, casualty_collection, forward_command, water_point, rest_area',
      'Valid decision_types: containment, tactical_deployment, resource_request, communication, medical_response, evacuation, investigation, public_information, negotiation, hazmat_response',
    );

    return parts.join('\n');
  }

  private buildUserPrompt(agent: AgentState, event: WebSocketEvent): string {
    const parts: string[] = [];

    parts.push(`A new event just occurred in the exercise at ${event.timestamp}:`);
    parts.push(`Event type: ${event.type}`);
    parts.push(`Event data: ${JSON.stringify(event.data, null, 2).slice(0, 2000)}`);

    if (agent.recentActions.length > 0) {
      parts.push('', 'Your recent actions (do not repeat):');
      for (const action of agent.recentActions.slice(-6)) {
        parts.push(`- ${action}`);
      }
    }

    parts.push('', 'What is your next action? Respond with JSON only.');

    return parts.join('\n');
  }

  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AgentActionResponse | null> {
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
          max_tokens: 600,
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

      return JSON.parse(content) as AgentActionResponse;
    } catch (err) {
      logger.error({ error: err }, 'AI agent: OpenAI call exception');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  private async executeAgentAction(
    session: SessionAgents,
    agent: AgentState,
    action: AgentActionResponse,
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
        await this.dispatcher.createPlacement(sessionId, botUserId, {
          team_name: teamName,
          asset_type: action.placement.asset_type,
          label: action.placement.label || action.placement.asset_type.replace(/_/g, ' '),
          geometry: action.placement.geometry,
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
