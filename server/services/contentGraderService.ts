import { logger } from '../lib/logger.js';
import { env } from '../env.js';

export interface ContentGrade {
  format: string;
  accuracy: number;
  tone: number;
  cultural_sensitivity: number;
  persuasiveness: number;
  completeness: number;
  overall: number;
  feedback: string;
  strengths: string[];
  improvements: string[];
  dimensions: Record<string, number>;
  signals: Record<string, boolean>;
  media_concept_grade?: number;
  media_feedback?: string;
}

const FORMAT_RUBRICS: Record<string, string> = {
  text: `Grade the following response on these criteria (each 0-100):

1. ACCURACY: Uses only verified facts? Cites official sources? Avoids speculation?
2. TONE: Empathetic, calm, authoritative? Not defensive, sarcastic, or preachy? Would a concerned stakeholder feel reassured?
3. CONTEXTUAL_SENSITIVITY: Appropriate for the crisis context? Avoids amplifying harmful narratives? Shows awareness of affected stakeholders' concerns?
4. PERSUASIVENESS: Would a concerned stakeholder be convinced? Does it address the underlying fears and concerns driving public outrage?
5. COMPLETENESS: Provides actionable guidance? Includes verified facts? Directs people to appropriate resources or channels?

ANTI-AMPLIFICATION CHECK: If the response QUOTES or REPEATS harmful content verbatim (even to debunk it), deduct 20 points from PERSUASIVENESS and 10 from CONTEXTUAL_SENSITIVITY.

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>, "persuasiveness": <0-100>, "completeness": <0-100> }
}`,

  official_statement: `Grade this OFFICIAL STATEMENT for a crisis response on these criteria (each 0-100):

1. ACCURACY: Factually correct? References only confirmed information?
2. AUTHORITY: Does it sound like it comes from a credible institution? Professional tone?
3. COMPLETENESS: Addresses the key claims circulating? Provides clear facts?
4. TONE: Empathetic but firm? Acknowledges community concern without being defensive?
5. CALL_TO_ACTION: Tells people what to do? Reports, helplines, official channels?

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "accuracy": <0-100>, "authority": <0-100>, "completeness": <0-100>, "tone": <0-100>, "call_to_action": <0-100> }
}`,

  humor_meme: `Grade this HUMOR/MEME crisis response on these criteria (each 0-100):

1. RELEVANCE: Does the humor actually address the crisis narrative? Or is it just a random joke?
2. CLEVERNESS: Is it genuinely funny/shareable? Or forced/cringe "fellow kids" energy?
3. TASTE: Does it punch UP at aggressors/misinformation, not DOWN at those affected? Would affected stakeholders find this empowering rather than dismissive?
4. MESSAGE_RETENTION: After laughing, will people remember the factual counter-narrative? Or does humor overshadow the point?
5. PRODUCTION_QUALITY: Does the described concept suggest something polished and professional, or hastily thrown together?

CRITICAL: Humor during a crisis is HIGH-RISK. Grade harshly if the humor trivializes those affected, makes light of harm, or could be screenshotted out of context to embarrass the response team. Grade generously if it effectively disarms harmful narratives through wit.

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "relevance": <0-100>, "cleverness": <0-100>, "taste": <0-100>, "message_retention": <0-100>, "production_quality": <0-100> }
}`,

  video_concept: `Grade this VIDEO CONCEPT for crisis response on these criteria (each 0-100):

1. CONCEPT_CLARITY: Is the video concept clearly described? Could a production team execute it?
2. EMOTIONAL_IMPACT: Would this video move people emotionally? Create empathy?
3. SHAREABILITY: Is this the kind of video people would share? Does it have viral potential?
4. MESSAGE_RETENTION: Would viewers remember the key message after watching?
5. PRODUCTION_QUALITY: Does the concept suggest high production value? Or is it amateurish?

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "concept_clarity": <0-100>, "emotional_impact": <0-100>, "shareability": <0-100>, "message_retention": <0-100>, "production_quality": <0-100> }
}`,

  infographic: `Grade this INFOGRAPHIC content for crisis response on these criteria (each 0-100):

1. DATA_ACCURACY: Are the facts and figures verifiable and correct?
2. VISUAL_CLARITY: Is the described layout logical? Would a layperson understand it in 5 seconds?
3. SOURCE_ATTRIBUTION: Does it cite official sources? Can readers verify the claims?
4. SHAREABILITY: Is it formatted for easy reposting? Clean, concise, visually distinct?
5. COMPLETENESS: Does it cover the key facts needed to counter the misinformation?

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "data_accuracy": <0-100>, "visual_clarity": <0-100>, "source_attribution": <0-100>, "shareability": <0-100>, "completeness": <0-100> }
}`,

  personal_story: `Grade this PERSONAL STORY/TESTIMONY for crisis response on these criteria (each 0-100):

1. AUTHENTICITY: Does it feel genuine and heartfelt? Not performative or manufactured?
2. EMOTIONAL_RESONANCE: Does it create empathy? Would a reader feel moved?
3. FACTUAL_CONNECTION: Does it tie the personal experience to the broader counter-narrative and facts?
4. CONTEXTUAL_SENSITIVITY: Does it respect affected stakeholders? Appropriate level of personal disclosure?
5. VULNERABILITY_BALANCE: Vulnerable enough to be powerful, but not so raw that it undermines the professional response?

Return ONLY valid JSON:
{
  "accuracy": <0-100>, "tone": <0-100>, "cultural_sensitivity": <0-100>,
  "persuasiveness": <0-100>, "completeness": <0-100>, "overall": <0-100>,
  "feedback": "<2-3 sentence summary>",
  "strengths": ["..."], "improvements": ["..."],
  "dimensions": { "authenticity": <0-100>, "emotional_resonance": <0-100>, "factual_connection": <0-100>, "cultural_sensitivity": <0-100>, "vulnerability_balance": <0-100> }
}`,
};

export async function gradePlayerContent(
  playerContent: string,
  context: {
    crisis_description: string;
    confirmed_facts: string[];
    content_guidelines?: Record<string, unknown>;
    hateful_post_being_addressed?: string;
    research_guidelines?: Array<{ best_practice: string; source_basis: string }>;
    post_format?: string;
    elapsed_minutes?: number;
    image_prompt?: string;
  },
): Promise<ContentGrade> {
  if (!env.openAiApiKey) {
    return defaultGrade('AI grading not available - no API key configured', context.post_format);
  }

  const format = context.post_format || 'text';
  const rubric = FORMAT_RUBRICS[format] || FORMAT_RUBRICS.text;

  try {
    const systemPrompt = `You are an expert evaluator for a crisis response team. Evaluate responses based on the specific crisis context provided below.
You evaluate responses from a STAKEHOLDER AND PUBLIC PROTECTION perspective -- NOT whether the response "wins an argument."

${rubric}

Context about the crisis:
${context.crisis_description}

Confirmed facts available:
${context.confirmed_facts.map((f) => '- ' + f).join('\\n')}

${context.hateful_post_being_addressed ? 'The harmful post being addressed:\\n' + context.hateful_post_being_addressed : ''}

${context.research_guidelines?.length ? 'Doctrine-based best practices to evaluate against:\\n' + context.research_guidelines.map((g) => '- ' + g.best_practice + ' (' + g.source_basis + ')').join('\\n') : ''}

${context.elapsed_minutes != null ? `Time elapsed since crisis began: ${context.elapsed_minutes} minutes. Consider whether the timing is appropriate for this type of content.` : ''}

Post format declared by player: ${format}

SEMANTIC SIGNALS: In addition to grading, evaluate these boolean signals about the player's post content. Return them in a "signals" object alongside the other fields:

- acknowledged_affected_parties: true if the post acknowledges those affected by the crisis and expresses empathy
- no_collective_blame: true if the post avoids unfair generalizations or scapegoating of any group
- includes_actionable_guidance: true if the post provides concrete next steps, resources, reporting channels, or practical help
- includes_safety_info: true if the post includes relevant safety or protective information for affected parties
- avoids_harmful_amplification: true if the post does not inadvertently amplify harmful narratives or repeat damaging content
- cites_verified_sources: true if the post references official sources, verified statements, or authoritative information
- promotes_constructive_dialogue: true if the post encourages calm, fact-based discussion and constructive engagement
- addresses_specific_claims: true if the post directly addresses or corrects specific false or misleading claims circulating online

${
  context.image_prompt
    ? `MEDIA CONCEPT: The player also described media they want to attach to this post:
"${context.image_prompt}"

Evaluate the media concept as part of your grading. Include these additional fields in your JSON response:
- "media_concept_grade": 0-100 score evaluating:
  * CONCEPT_CREATIVITY: Is the media idea original and strategic? Does it add value beyond text alone?
  * VISUAL_STRATEGY: Would this visual support the narrative effectively? Is it appropriate for the crisis context?
  * PRODUCTION_INTENT: Does the concept show understanding of visual communication in crisis management?
- "media_feedback": A 1-2 sentence assessment of the media concept's strategic value and any improvements.`
    : ''
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Grade this ${format} response:\n\n${playerContent}` },
        ],
        temperature: 0.3,
        max_completion_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI content grading failed');
      return defaultGrade('AI grading temporarily unavailable', format);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return defaultGrade('Empty AI response', format);

    const grade = JSON.parse(content) as ContentGrade;
    grade.format = format;
    if (!grade.dimensions) {
      grade.dimensions = {
        accuracy: grade.accuracy || 50,
        tone: grade.tone || 50,
        cultural_sensitivity: grade.cultural_sensitivity || 50,
        persuasiveness: grade.persuasiveness || 50,
        completeness: grade.completeness || 50,
      };
    }
    if (!grade.signals) {
      grade.signals = {};
    }
    return grade;
  } catch (err) {
    logger.error({ err }, 'Content grading error');
    return defaultGrade('Grading failed', format);
  }
}

function defaultGrade(feedback: string, format?: string): ContentGrade {
  return {
    format: format || 'text',
    accuracy: 50,
    tone: 50,
    cultural_sensitivity: 50,
    persuasiveness: 50,
    completeness: 50,
    overall: 50,
    feedback,
    strengths: [],
    improvements: [],
    dimensions: {
      accuracy: 50,
      tone: 50,
      cultural_sensitivity: 50,
      persuasiveness: 50,
      completeness: 50,
    },
    signals: {},
  };
}
