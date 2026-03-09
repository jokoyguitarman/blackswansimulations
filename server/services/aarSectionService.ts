/**
 * AAR Section Service
 * Builds section-based AAR data and generates per-section AI analysis (Option B).
 * Revertible: when AAR_REPORT_FORMAT=legacy this service is not used.
 */

export const AAR_SECTION_KEYS = [
  'executive',
  'decisions',
  'matrices',
  'injects_published',
  'injects_cancelled',
  'coordination',
  'escalation',
  'incident_response',
  'insider_usage',
  'team_metrics',
  'resource_requests',
  'pathway_outcomes',
  'information_analysis',
  'recommendations',
] as const;

export type AARSectionKey = (typeof AAR_SECTION_KEYS)[number];

export interface SectionEntry {
  data: unknown;
  analysis: string | null;
}

export type SectionsMap = Partial<Record<AARSectionKey, SectionEntry>>;

export interface BuildSectionsInput {
  scenarioTitle?: string;
  scenarioDescription?: string;
  objectives: Array<{ objective_name?: string; status?: string; progress_percentage?: number }>;
  durationMinutes: number;
  participantCount: number;
  decisions: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    created_at: string;
    executed_at?: string;
    proposed_by?: string;
    description?: string;
  }>;
  decisionSteps: Array<{
    decision_id: string;
    role: string;
    status: string;
    timestamp?: string;
    created_at?: string;
  }>;
  robustnessHistoryByDecisionId: Record<string, Array<{ evaluated_at: string; score: number }>>;
  impactMatrices: Array<{
    evaluated_at: string;
    matrix: Record<string, Record<string, number>>;
    robustness_by_decision: Record<string, number>;
    analysis?: { overall?: string; matrix_reasoning?: string; robustness_reasoning?: string };
    response_taxonomy?: Record<string, string>;
  }>;
  injectsPublished: Array<{
    at: string;
    type?: string;
    title?: string;
    content?: string;
    severity?: string;
    inject_scope?: string;
  }>;
  injectsCancelled: Array<{ at: string; inject_id?: string; reason?: string }>;
  communication: Record<string, unknown>;
  participantSummary: Array<{
    displayName: string;
    role: string;
    messageCount: number;
    decisionsProposed: number;
  }>;
  escalationFactors: Array<{
    evaluated_at: string;
    factors: unknown[];
    de_escalation_factors?: unknown[];
  }>;
  escalationPathways: Array<{
    evaluated_at: string;
    pathways: unknown[];
    de_escalation_pathways?: unknown[];
  }>;
  incidentResponsePairs?: Array<{
    incident: {
      id: string;
      title: string;
      description?: string;
      reported_at?: string;
      inject_id?: string;
    };
    decision: {
      id: string;
      title: string;
      description?: string;
      executed_at?: string;
      proposed_by?: string;
    };
    robustness?: number;
    environmentalConsistency?: unknown;
    latencyMinutes?: number;
    insiderConsulted?: boolean;
    intelMatch?: boolean;
  }>;
  insiderUsage?: {
    questions: Array<{
      question_text?: string;
      category?: string;
      asked_by?: string;
      asked_at?: string;
    }>;
    gaps: Array<{ incident_id: string; incident_title: string; decision_id?: string }>;
  };
  teamMetricsHistory?: Array<{
    at: string;
    evacuation_state?: unknown;
    triage_state?: unknown;
    media_state?: unknown;
  }>;
  resourceRequests?: Array<{
    from_agency?: string;
    to_agency?: string;
    resource_type?: string;
    quantity?: number;
    status?: string;
    created_at?: string;
  }>;
  pathwayOutcomes?: Array<{
    trigger_inject_id?: string;
    evaluated_at?: string;
    outcomes?: unknown[];
    chosenBand?: string;
    linkedDecisionId?: string;
  }>;
}

/**
 * Build the sections payload (data only; analysis filled later by AI).
 */
export function buildSectionsData(input: BuildSectionsInput): SectionsMap {
  const sections: SectionsMap = {};

  sections.executive = {
    data: {
      scenarioTitle: input.scenarioTitle,
      scenarioDescription: input.scenarioDescription
        ? input.scenarioDescription.slice(0, 2000)
        : undefined,
      objectives: input.objectives,
      durationMinutes: input.durationMinutes,
      participantCount: input.participantCount,
    },
    analysis: null,
  };

  sections.decisions = {
    data: {
      decisions: input.decisions.map((d) => ({
        id: d.id,
        title: d.title,
        type: d.type,
        status: d.status,
        created_at: d.created_at,
        executed_at: d.executed_at,
        proposed_by: d.proposed_by,
        description: d.description ? String(d.description).slice(0, 500) : undefined,
      })),
      decisionSteps: input.decisionSteps,
      robustnessHistoryByDecisionId: input.robustnessHistoryByDecisionId,
    },
    analysis: null,
  };

  const matricesCap = input.impactMatrices.slice(0, 50);
  sections.matrices = {
    data: matricesCap.map((m) => ({
      evaluated_at: m.evaluated_at,
      matrix: m.matrix,
      robustness_by_decision: m.robustness_by_decision,
      analysis: m.analysis,
      response_taxonomy: m.response_taxonomy,
    })),
    analysis: null,
  };

  sections.injects_published = {
    data: input.injectsPublished,
    analysis: null,
  };

  sections.injects_cancelled = {
    data: input.injectsCancelled,
    analysis: null,
  };

  sections.coordination = {
    data: {
      communication: input.communication,
      participantSummary: input.participantSummary,
    },
    analysis: null,
  };

  sections.escalation = {
    data: {
      factors: input.escalationFactors.slice(0, 20),
      pathways: input.escalationPathways.slice(0, 20),
    },
    analysis: null,
  };

  sections.incident_response = {
    data: input.incidentResponsePairs ?? [],
    analysis: null,
  };

  sections.insider_usage = {
    data: input.insiderUsage ?? { questions: [], gaps: [] },
    analysis: null,
  };

  sections.team_metrics = {
    data: input.teamMetricsHistory ?? [],
    analysis: null,
  };

  sections.resource_requests = {
    data: input.resourceRequests ?? [],
    analysis: null,
  };

  sections.pathway_outcomes = {
    data: input.pathwayOutcomes ?? [],
    analysis: null,
  };

  sections.information_analysis = {
    data: { note: 'Synthesise from insider_usage and coordination sections' },
    analysis: null,
  };

  sections.recommendations = {
    data: { note: 'Synthesise from other sections' },
    analysis: null,
  };

  return sections;
}

const MAX_RECOMMENDATIONS_CONTEXT_CHARS = 10000;

/**
 * Build context for the recommendations section: other sections' analyses (and brief data hints)
 * so the AI can synthesise key takeaways. Call this when recommendations is generated last.
 */
export function buildRecommendationsContext(sections: SectionsMap): unknown {
  const otherKeys = (AAR_SECTION_KEYS as readonly string[]).filter((k) => k !== 'recommendations');
  const otherSections: Array<{
    sectionKey: string;
    label: string;
    analysis: string | null;
    dataSummary?: string;
  }> = [];
  let totalLen = 0;
  for (const key of otherKeys) {
    const k = key as AARSectionKey;
    const entry = sections[k];
    if (!entry) continue;
    const label = SECTION_LABELS[k] ?? k;
    const analysis = entry.analysis ?? null;
    let dataSummary: string | undefined;
    if (entry.data != null && typeof entry.data === 'object') {
      dataSummary = JSON.stringify(entry.data).slice(0, 500);
    }
    const block = { sectionKey: k, label, analysis, dataSummary };
    const blockStr = JSON.stringify(block);
    if (totalLen + blockStr.length > MAX_RECOMMENDATIONS_CONTEXT_CHARS) break;
    otherSections.push(block);
    totalLen += blockStr.length;
  }
  return { otherSections };
}

/**
 * Build context for the information_analysis section: insider_usage and coordination analyses
 * so the AI can synthesise information-sharing effectiveness.
 */
export function buildInformationAnalysisContext(sections: SectionsMap): unknown {
  const sourceKeys: AARSectionKey[] = ['insider_usage', 'coordination'];
  const blocks: Array<{
    sectionKey: string;
    label: string;
    analysis: string | null;
    dataSummary?: string;
  }> = [];
  for (const key of sourceKeys) {
    const entry = sections[key];
    if (!entry) continue;
    const label = SECTION_LABELS[key] ?? key;
    blocks.push({
      sectionKey: key,
      label,
      analysis: entry.analysis ?? null,
      dataSummary:
        entry.data != null && typeof entry.data === 'object'
          ? JSON.stringify(entry.data).slice(0, 800)
          : undefined,
    });
  }
  return { sourceSections: blocks };
}

const SECTION_LABELS: Record<AARSectionKey, string> = {
  executive: 'Executive overview',
  decisions: 'Decisions and scoring history',
  matrices: 'Impact matrices',
  injects_published: 'Injects published',
  injects_cancelled: 'Injects cancelled',
  coordination: 'Coordination and communication',
  escalation: 'Escalation factors and pathways',
  incident_response: 'Incident–Response pairs',
  insider_usage: 'Insider information usage',
  team_metrics: 'Team metrics over time',
  resource_requests: 'Resource requests and transfers',
  pathway_outcomes: 'Pathway outcomes',
  information_analysis: 'Information-sharing analysis',
  recommendations: 'Key takeaways and recommendations',
};

const SECTION_INSTRUCTIONS: Partial<Record<AARSectionKey, string>> = {
  executive:
    'Set the scene from the scenario; state whether objectives were met overall and how the session aligned with the scenario. Be concise.',
  decisions:
    'Assess timing of decisions vs injects; note robustness trends over time; cite specific decision titles and scores. Do not repeat the raw table.',
  matrices:
    'Interpret inter-team impact and robustness by decision; note which teams or decisions improved or worsened over time. Cite evaluated_at and scores.',
  injects_published:
    'Assess whether team responses matched injects and were timely; note gaps or strong responses. Reference specific inject titles and times.',
  injects_cancelled:
    'Assess whether cancellations were appropriate given recent decisions; note consistency and impact on exercise flow.',
  coordination:
    'Assess participation balance, response times, and inter-agency communication. Cite roles and message counts.',
  escalation:
    'Summarise how escalation factors and pathways evolved and how decisions/injects aligned with them.',
  incident_response:
    'Assess incident–response pairs: robustness scores, environmental consistency, latency, whether Insider was consulted, and intel match. Note patterns and gaps.',
  insider_usage:
    'Assess how well the team used Insider information: questions asked, categories, timing. Highlight gaps where intel existed but was not consulted before decisions.',
  team_metrics:
    'Interpret evacuation, triage, and media state evolution over time. Note key transitions and whether team decisions aligned with state changes.',
  resource_requests:
    'Assess resource request and transfer patterns: agencies involved, status outcomes, timing. Note coordination effectiveness.',
  pathway_outcomes:
    'Interpret pathway outcomes: which robustness bands led to which outcome injects, links to incident–response pairs. Note escalation vs de-escalation trajectories.',
  information_analysis:
    'Synthesise from insider_usage and coordination: how well did the team share and use information? Were there missed opportunities to consult Insider or coordinate?',
  recommendations:
    'Prioritise 3–5 actionable recommendations. Reference specific sections (decisions, matrices, injects, coordination, incident_response, insider_usage) where relevant.',
};

/**
 * Generate AI analysis for a single section. Returns analysis text or throws.
 */
export async function generateSectionAnalysis(
  sectionKey: AARSectionKey,
  sectionData: unknown,
  context: { sessionId: string; scenarioTitle?: string },
  openAiApiKey: string,
): Promise<string> {
  const label = SECTION_LABELS[sectionKey];
  const extra =
    SECTION_INSTRUCTIONS[sectionKey] ?? 'Interpret and assess; cite specific numbers and times.';

  const isRecommendations = sectionKey === 'recommendations';
  const isInformationAnalysis = sectionKey === 'information_analysis';
  const systemPrompt = isRecommendations
    ? `You are an expert crisis management analyst. Below you will receive the analyses from the other AAR sections (executive overview, decisions, matrices, injects, coordination, escalation, incident_response, insider_usage, team_metrics, resource_requests, pathway_outcomes, information_analysis). Synthesise them into 3–5 actionable key takeaways and recommendations. Reference specific sections where relevant. Be concrete and practical. ${extra}`
    : isInformationAnalysis
      ? `You are an expert crisis management analyst. Below you will receive the analyses from the insider_usage and coordination sections. Synthesise them into an information-sharing analysis: how well did the team use and share information? Were there missed opportunities to consult Insider or coordinate? Be concise (1–2 paragraphs). ${extra}`
      : `You are an expert crisis management analyst. Below is the "${label}" data for a training exercise AAR. Write a concise analysis (1–2 paragraphs) that cites specific numbers, times, and names. Do not repeat the raw data; interpret and assess. ${extra}`;

  const dataJson =
    typeof sectionData === 'string'
      ? sectionData
      : JSON.stringify(sectionData, null, 2).slice(0, 12000);

  const userPrompt = isRecommendations
    ? `Session: ${context.sessionId}${context.scenarioTitle ? `; Scenario: ${context.scenarioTitle}` : ''}\n\nAnalyses from other AAR sections (use these to synthesise key takeaways and recommendations):\n${dataJson}\n\nWrite 3–5 actionable key takeaways and recommendations now.`
    : isInformationAnalysis
      ? `Session: ${context.sessionId}${context.scenarioTitle ? `; Scenario: ${context.scenarioTitle}` : ''}\n\nSource sections (insider_usage and coordination):\n${dataJson}\n\nWrite the information-sharing analysis now.`
      : `Session: ${context.sessionId}${context.scenarioTitle ? `; Scenario: ${context.scenarioTitle}` : ''}\n\nData for ${label}:\n${dataJson}\n\nWrite the analysis now.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `OpenAI ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('No content from OpenAI');
  }
  return content.trim();
}
