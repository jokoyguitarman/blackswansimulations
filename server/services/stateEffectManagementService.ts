import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

type ManagedEffectsState = Record<
  string,
  { managed?: boolean; managed_at?: string; managed_by_decision_id?: string }
>;

export interface StateEffectCandidate {
  key: string;
  label: string;
  details?: string;
}

function getManagedEffects(currentState: Record<string, unknown>): ManagedEffectsState {
  const raw = currentState.managed_effects;
  if (!raw || typeof raw !== 'object') return {};
  return raw as ManagedEffectsState;
}

function isManaged(currentState: Record<string, unknown>, effectKey: string): boolean {
  const managed = getManagedEffects(currentState)[effectKey];
  return managed?.managed === true;
}

function buildActiveStateEffects(currentState: Record<string, unknown>): StateEffectCandidate[] {
  const candidates: StateEffectCandidate[] = [];

  const evac = (currentState.evacuation_state as Record<string, unknown>) || {};
  const exits = evac.exits_congested as unknown;
  if (Array.isArray(exits)) {
    for (const e of exits) {
      if (typeof e !== 'string' || !e.trim()) continue;
      const exitName = e.trim();
      const key = `evacuation.exits_congested:${exitName}`;
      if (isManaged(currentState, key)) continue;
      candidates.push({
        key,
        label: `Decongest ${exitName}`,
        details: 'Evacuation exit congestion is reducing evacuation flow rate.',
      });
    }
  }

  const triage = (currentState.triage_state as Record<string, unknown>) || {};
  if (triage.surge_active === true) {
    const key = 'triage.surge_active';
    if (!isManaged(currentState, key)) {
      candidates.push({
        key,
        label: 'Manage triage surge',
        details:
          'Triage surge pressure is active and needs concrete prioritisation/throughput actions.',
      });
    }
  }
  const supplyLevel = triage.supply_level;
  if (supplyLevel === 'low' || supplyLevel === 'critical') {
    const key = `triage.supply_level:${String(supplyLevel)}`;
    if (!isManaged(currentState, key)) {
      candidates.push({
        key,
        label: `Resolve triage supply ${String(supplyLevel)}`,
        details:
          'Triage supplies are degraded; credible supply request/rationing/logistics needed.',
      });
    }
  }

  const media = (currentState.media_state as Record<string, unknown>) || {};
  if (media.journalist_arrived === true) {
    const key = 'media.journalist_arrived';
    if (!isManaged(currentState, key)) {
      candidates.push({
        key,
        label: 'Manage journalist presence',
        details:
          'Journalists are present; requires media control, spokespersoning, and briefing plan.',
      });
    }
  }

  return candidates;
}

function decisionMentionsAnyEffect(decisionText: string, effects: StateEffectCandidate[]): boolean {
  const t = decisionText.toLowerCase();
  return effects.some((e) => {
    const key = e.key.toLowerCase();
    const label = e.label.toLowerCase();
    // quick heuristics: key or label fragments present
    const token = key.split(':')[0];
    return (
      t.includes(token) ||
      t.includes(label) ||
      (key.includes(':') && t.includes(key.split(':')[1].toLowerCase()))
    );
  });
}

async function evaluateEffectsAddressed(
  params: {
    decisionTitle: string;
    decisionDescription: string;
    activeEffects: StateEffectCandidate[];
  },
  openAiApiKey: string,
): Promise<Array<{ key: string; confidence: number }>> {
  const systemPrompt = `You are an expert crisis-operations evaluator. You decide whether a player's DECISION credibly manages one or more ACTIVE STATE EFFECTS in a crisis simulation.\n\nRules:\n- Only mark an effect as addressed if the decision is concrete and operationally plausible (who/what/where/how), and clearly tied to that specific effect.\n- Vague intent statements (e.g. "clear congestion", "manage surge") do NOT count.\n- If the decision does not name a specific exit/zone or does not describe concrete flow-control measures, it does NOT address exit congestion.\n- Output JSON only.\n\nReturn JSON: { "effects_addressed": [ { "key": string, "confidence": number } ] }\n- confidence is 0.0 to 1.0\n- Include only keys from the provided ACTIVE EFFECTS list.`;

  const effectsText = params.activeEffects
    .map((e) => `- key=${e.key} | label=${e.label}${e.details ? ` | details=${e.details}` : ''}`)
    .join('\n');

  const userPrompt = `ACTIVE EFFECTS:\n${effectsText}\n\nDECISION:\nTitle: ${params.decisionTitle}\nDescription: ${params.decisionDescription}\n\nWhich active effects are credibly addressed by this decision? Return JSON only.`;

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
      max_tokens: 250,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.warn({ status: response.status, body: text }, 'State effect management AI call failed');
    return [];
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const obj = parsed as { effects_addressed?: unknown };
  const arr = Array.isArray(obj.effects_addressed) ? obj.effects_addressed : [];
  const allowed = new Set(params.activeEffects.map((e) => e.key));
  const results: Array<{ key: string; confidence: number }> = [];
  for (const row of arr) {
    const r = row as { key?: unknown; confidence?: unknown };
    const key = typeof r.key === 'string' ? r.key : '';
    const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
    if (!allowed.has(key)) continue;
    results.push({ key, confidence: Math.max(0, Math.min(1, confidence)) });
  }
  return results;
}

export async function evaluateStateEffectManagementAndUpdateState(
  sessionId: string,
  decision: { id: string; title: string; description: string },
  openAiApiKey: string | undefined,
  actorId?: string | null,
): Promise<void> {
  if (!openAiApiKey?.trim()) return;

  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('sessions')
    .select('current_state')
    .eq('id', sessionId)
    .single();
  if (sessionErr || !session) return;

  const currentState = ((session as { current_state?: Record<string, unknown> }).current_state ??
    {}) as Record<string, unknown>;

  const active = buildActiveStateEffects(currentState);
  if (active.length === 0) return;

  const decisionText = `${decision.title}\n${decision.description}`.trim();
  if (!decisionMentionsAnyEffect(decisionText, active)) return;

  const addressed = await evaluateEffectsAddressed(
    {
      decisionTitle: decision.title,
      decisionDescription: decision.description,
      activeEffects: active,
    },
    openAiApiKey,
  );
  const toManage = addressed.filter((r) => r.confidence >= 0.7).map((r) => r.key);
  if (toManage.length === 0) return;

  const managedEffects = { ...getManagedEffects(currentState) };
  const now = new Date().toISOString();
  for (const key of toManage) {
    managedEffects[key] = {
      managed: true,
      managed_at: now,
      managed_by_decision_id: decision.id,
    };
  }

  const nextState: Record<string, unknown> = { ...currentState, managed_effects: managedEffects };

  const { error: updateErr } = await supabaseAdmin
    .from('sessions')
    .update({ current_state: nextState })
    .eq('id', sessionId);
  if (updateErr) {
    logger.warn({ sessionId, error: updateErr }, 'Failed to persist managed_effects update');
    return;
  }

  try {
    await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: 'state_effect_managed',
      description: 'State effect managed by decision',
      actor_id: actorId ?? null,
      metadata: { decision_id: decision.id, managed_effect_keys: toManage },
    });
  } catch (e) {
    logger.warn({ err: e, sessionId }, 'Failed to write state_effect_managed session_event');
  }

  getWebSocketService().stateUpdated?.(sessionId, {
    state: nextState,
    timestamp: now,
  });
}
