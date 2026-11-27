import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { StoredTurn } from './callTypes.js';

/**
 * Stakeholder memory for a finished call. Appends every turn, then runs
 * reconsideration once so the call can change that stakeholder's pending injects.
 * Failures are logged and never fail the call.
 */
export async function rememberEndedCall(
  call: { sessionId: string; stakeholderId: string | null; id: string; answeredBy: string | null },
  turns: StoredTurn[],
): Promise<void> {
  if (!call.stakeholderId || turns.length === 0) return;
  try {
    const { appendConversation, buildCharacterPrompt, getConversationLog, loadScenarioCtx, resolveContext, resolvePlayerRef } =
      await import('../stakeholderReplyService.js');
    for (const turn of turns) {
      if (turn.speaker === 'system') continue;
      await appendConversation({
        sessionId: call.sessionId,
        stakeholderId: call.stakeholderId,
        channel: 'phone',
        direction: turn.speaker === 'player' ? 'player' : 'npc',
        userId: turn.speaker === 'player' ? turn.userId ?? call.answeredBy : null,
        content: turn.text,
        refTable: 'sim_calls',
        refId: call.id,
      });
    }
    if (!env.enableStakeholderEngine || !env.aiEnabled || !call.answeredBy) return;
    const { findById } = await import('../stakeholderService.js');
    const { getSessionScenarioId } = await import('../../lib/scenarioCache.js');
    const { getTeamIdentity } = await import('../orgRegistryService.js');
    const { decideAndReply } = await import('../stakeholderReconsiderationService.js');
    const scenarioId = await getSessionScenarioId(call.sessionId);
    if (!scenarioId) return;
    const stakeholder = await findById(scenarioId, call.stakeholderId);
    if (!stakeholder || stakeholder.kind === 'group') return;
    const playerText = turns.filter((turn) => turn.speaker === 'player').map((turn) => turn.text).join('\n');
    if (!playerText.trim()) return;
    const identity = await getTeamIdentity(call.sessionId, call.answeredBy).catch(() => null);
    const [log, scenarioCtx, context, player] = await Promise.all([
      getConversationLog(call.sessionId, stakeholder.id),
      loadScenarioCtx(scenarioId),
      resolveContext(call.sessionId, stakeholder),
      resolvePlayerRef(call.sessionId, call.answeredBy, identity),
    ]);
    await decideAndReply({
      sessionId: call.sessionId,
      stakeholder,
      characterPrompt: buildCharacterPrompt(stakeholder, log, scenarioCtx, { context }),
      log,
      channel: 'phone',
      latestPlayerMessage: playerText,
      teamIdentity: identity,
      player,
    });
  } catch (err) {
    logger.warn({ err, callId: call.id, event: 'call_memory_failed' }, 'Call stakeholder memory failed');
  }
}
