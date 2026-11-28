/**
 * A director proposal becomes one runtime inject. The trigger depth is WP4
 * `causeDepth` (inherited hops + 1) over the causing signals' condition keys.
 */

import { causeDepth, referencedInjectKeys, type DepthTrigger } from '../conditions/crossTeamCore.js';
import type { Signal } from './directorSignals.js';
import type { ParsedProposal } from './directorCore.js';

const APP_TYPE: Record<string, string> = {
  email: 'email',
  group_chat: 'chat_message',
  phone_call: 'phone_call',
  npc_dm: 'chat_message',
  messenger_dm: 'chat_message',
  social_feed: 'social_post',
  news: 'news',
};

const PUBLIC_APPS = new Set(['social_feed', 'news']);

export interface DirectorPerson {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  handle?: string | null;
  organisation?: string | null;
}

export interface DirectorNpc {
  handle: string;
  name?: string;
}

export interface DirectorInjectDraft {
  injectKey: string;
  row: Record<string, unknown>;
  metKeys: string[];
  parentInjectKeys: string[];
  causeDepth: number;
  sourceTeams: string[];
  targetTeams: string[];
}

export function directorCauseDepth(
  signals: readonly Signal[],
  triggersByKey: Readonly<Record<string, DepthTrigger | undefined>>,
): { depth: number; metKeys: string[]; parentInjectKeys: string[] } {
  const metKeys = [...new Set(signals.flatMap((signal) => signal.keys))].sort((a, b) =>
    a.localeCompare(b),
  );
  const parentInjectKeys = [...new Set(metKeys.flatMap((key) => referencedInjectKeys(key)))].sort(
    (a, b) => a.localeCompare(b),
  );
  return { depth: causeDepth(metKeys, triggersByKey), metKeys, parentInjectKeys };
}

export function buildDirectorInject(input: {
  scenarioId: string;
  sessionId: string;
  proposalId: string;
  seq: number;
  minute: number;
  mode: 'suggest' | 'auto';
  approvedBy: string | null;
  proposal: ParsedProposal;
  signals: readonly Signal[];
  triggersByKey: Readonly<Record<string, DepthTrigger | undefined>>;
  people: readonly DirectorPerson[];
  npcs: readonly DirectorNpc[];
}): DirectorInjectDraft {
  const proposal = input.proposal;
  const cause = directorCauseDepth(input.signals, input.triggersByKey);
  const injectKey = `dir_${input.seq}`;
  const sender = senderFields(proposal, input.people, input.npcs);
  const follow = followUpChain(proposal);
  const publicApp = PUBLIC_APPS.has(proposal.app);
  const teams = [...proposal.target_teams];
  const delivery: Record<string, unknown> = {
    app: proposal.app,
    inject_key: injectKey,
    ...sender,
    ...(proposal.response_rubric ? { response_rubric: proposal.response_rubric } : {}),
    ...(follow ? { escalation: follow } : {}),
    director: {
      proposal_id: input.proposalId,
      mode: input.mode,
      approved_by: input.approvedBy,
    },
    cause: {
      kind: 'director',
      signal_ids: proposal.cause.signal_ids,
      source_teams: proposal.cause.source_teams,
    },
  };
  return {
    injectKey,
    metKeys: cause.metKeys,
    parentInjectKeys: cause.parentInjectKeys,
    causeDepth: cause.depth,
    sourceTeams: [...proposal.cause.source_teams],
    targetTeams: teams,
    row: {
      scenario_id: input.scenarioId,
      session_id: input.sessionId,
      type: APP_TYPE[proposal.app] ?? proposal.app,
      title: proposal.title,
      content: proposal.content,
      severity: proposal.severity,
      inject_scope: teams.length > 0 && !publicApp ? 'team_specific' : 'universal',
      target_teams: teams,
      trigger_time_minutes: null,
      conditions_to_appear: null,
      conditions_to_cancel: null,
      requires_response: proposal.requires_response,
      requires_coordination: false,
      ai_generated: true,
      generation_source: 'ai_director',
      delivery_config: delivery,
    },
  };
}

function followUpChain(proposal: ParsedProposal): Record<string, unknown> | null {
  if (!proposal.follow_up) return null;
  const minutes = Math.min(30, Math.max(1, Math.round(proposal.follow_up.if_unanswered_minutes)));
  return {
    max_steps: 1,
    scope: 'per_team',
    stop_on: 'any_response',
    stop_on_contact: true,
    steps: [
      {
        after_minutes: minutes,
        urgency: 'follow_up',
        app: 'same',
        content_mode: 'template',
        template: proposal.follow_up.content,
      },
    ],
  };
}

function senderFields(
  proposal: ParsedProposal,
  people: readonly DirectorPerson[],
  npcs: readonly DirectorNpc[],
): Record<string, unknown> {
  if ('stakeholder_id' in proposal.sender) {
    const sender = proposal.sender;
    const person = people.find((row) => row.id === sender.stakeholder_id);
    const name = person?.name ?? sender.stakeholder_id;
    return {
      stakeholder_id: sender.stakeholder_id,
      from_name: name,
      sender_name: name,
      author_display_name: name,
      ...(person?.email ? { from_address: person.email } : {}),
      ...(person?.phone ? { from_number: person.phone } : {}),
      ...(person?.handle ? { author_handle: person.handle } : {}),
      ...(person?.organisation ? { outlet_name: person.organisation } : {}),
      ...(proposal.app === 'email' ? { email_category: 'stakeholder' } : {}),
      ...(proposal.app === 'social_feed' ? { author_type: 'npc_media', platform: 'x_twitter' } : {}),
    };
  }
  const handle = proposal.sender.npc_handle;
  const npc = npcs.find((row) => row.handle === handle);
  const name = npc?.name ?? handle;
  return {
    npc_handle: handle,
    author_handle: handle,
    from_name: name,
    sender_name: name,
    author_display_name: name,
    ...(proposal.app === 'social_feed' ? { author_type: 'npc_public', platform: 'x_twitter' } : {}),
  };
}
