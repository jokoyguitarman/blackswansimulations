import { logger } from '../lib/logger.js';

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
  escalationFactors: Array<{ evaluated_at: string; factors: unknown[]; de_escalation_factors?: unknown[] }>;
  escalationPathways: Array<{
    evaluated_at: string;
    pathways: unknown[];
    de_escalation_pathways?: unknown[];
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

  sections.recommendations = {
    data: { note: 'Synthesise from other sections' },
    analysis: null,
  };

  return sections;
}

const SECTION_LABELS: Record<AARSectionKey, string> = {
  executive: 'Executive overview',
  decisions: 'Decisions and scoring history',
  matrices: 'Impact matrices',
  injects_published: 'Injects published',
  injects_cancelled: 'Injects cancelled',
  coordination: 'Coordination and communication',
  escalation: 'Escalation factors and pathways',
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
  recommendations:
    'Prioritise 3–5 actionable recommendations. Reference specific sections (decisions, matrices, injects, coordination) where relevant.',
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
  const extra = SECTION_INSTRUCTIONS[sectionKey] ?? 'Interpret and assess; cite specific numbers and times.';

  const systemPrompt = `You are an expert crisis management analyst. Below is the "${label}" data for a training exercise AAR. Write a concise analysis (1–2 paragraphs) that cites specific numbers, times, and names. Do not repeat the raw data; interpret and assess. ${extra}`;

  const dataJson =
    typeof sectionData === 'string'
      ? sectionData
      : JSON.stringify(sectionData, null, 2).slice(0, 12000);

  const userPrompt = `Session: ${context.sessionId}${context.scenarioTitle ? `; Scenario: ${context.scenarioTitle}` : ''}\n\nData for ${label}:\n${dataJson}\n\nWrite the analysis now.`;

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
    throw new Error(
      errBody?.error?.message || `OpenAI ${response.status}`,
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('No content from OpenAI');
  }
  return content.trim();
}
