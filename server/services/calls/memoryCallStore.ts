import type { CallSessionInfo, CallStore, SimCall, StoredTurn } from './callTypes.js';

/** In-memory store for route tests. No network. */
export function createMemoryCallStore(): CallStore & {
  sessions: Map<string, CallSessionInfo>;
  members: Map<string, Record<string, Array<{ user_id: string; is_bot: boolean }>>>;
  participants: Map<string, string[]>;
  contacts: Array<{ sessionId: string; stakeholderId: string; at: string }>;
} {
  const calls = new Map<string, SimCall>();
  const turns = new Map<string, StoredTurn[]>();
  const views = new Map<string, string>();
  const sessions = new Map<string, CallSessionInfo>();
  const members = new Map<string, Record<string, Array<{ user_id: string; is_bot: boolean }>>>();
  const participants = new Map<string, string[]>();
  const contacts: Array<{ sessionId: string; stakeholderId: string; at: string }> = [];

  const store: CallStore = {
    async ready() {
      return true;
    },
    async insert(call) {
      const clash = Array.from(calls.values()).find((existing) => {
        if (existing.sessionId !== call.sessionId) return false;
        if (existing.callGroupId === call.callGroupId && existing.attemptNo === call.attemptNo) return true;
        return (
          call.direction === 'inbound' &&
          call.attemptNo === 1 &&
          existing.direction === 'inbound' &&
          existing.attemptNo === 1 &&
          existing.injectId != null &&
          existing.injectId === call.injectId &&
          (existing.recipientTeams[0] ?? '') === (call.recipientTeams[0] ?? '')
        );
      });
      if (clash) return { call: clash, created: false };
      calls.set(call.id, clone(call));
      return { call: clone(call), created: true };
    },
    async get(id) {
      const call = calls.get(id);
      return call ? clone(call) : null;
    },
    async claimAnswer(id, userId, at) {
      const call = calls.get(id);
      if (!call || call.status !== 'ringing') return null;
      call.status = 'connecting';
      call.answeredBy = userId;
      call.answeredAt = at;
      return clone(call);
    },
    async save(call) {
      calls.set(call.id, clone(call));
    },
    async listSession(sessionId) {
      return Array.from(calls.values())
        .filter((call) => call.sessionId === sessionId)
        .map(clone)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async listOpen(sessionId) {
      return (await store.listSession(sessionId)).filter((call) =>
        ['scheduled', 'ringing', 'connecting', 'active'].includes(call.status),
      );
    },
    async listActiveSideband() {
      return Array.from(calls.values())
        .filter((call) => call.status === 'active' && call.transcriptSource === 'sideband')
        .map(clone);
    },
    async activeCount(sessionId) {
      return (await store.listOpen(sessionId)).filter((call) =>
        call.status === 'connecting' || call.status === 'active',
      ).length;
    },
    async durationSeconds(sessionId) {
      return Array.from(calls.values())
        .filter((call) => call.sessionId === sessionId)
        .reduce((sum, call) => sum + (call.durationSeconds ?? 0), 0);
    },
    async userBusy(sessionId, userId, exceptCallId) {
      return Array.from(calls.values()).some(
        (call) =>
          call.sessionId === sessionId &&
          call.id !== exceptCallId &&
          call.answeredBy === userId &&
          (call.status === 'connecting' || call.status === 'active'),
      );
    },
    async appendTurns(next) {
      for (const turn of next) {
        const list = turns.get(turn.callId) ?? [];
        if (list.some((existing) => existing.seq === turn.seq)) continue;
        list.push({ ...turn });
        list.sort((a, b) => a.seq - b.seq);
        turns.set(turn.callId, list);
      }
    },
    async turns(callId) {
      return (turns.get(callId) ?? []).map((turn) => ({ ...turn }));
    },
    async recentsViewedAt(sessionId, userId) {
      return views.get(`${sessionId}:${userId}`) ?? null;
    },
    async setRecentsViewed(sessionId, userId, at) {
      views.set(`${sessionId}:${userId}`, at);
    },
    async playerContactedStakeholder(sessionId, stakeholderId, afterIso) {
      return contacts.some(
        (contact) =>
          contact.sessionId === sessionId &&
          contact.stakeholderId === stakeholderId &&
          contact.at > afterIso,
      );
    },
    async session(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async teamMembers(sessionId) {
      return members.get(sessionId) ?? {};
    },
    async participantIds(sessionId) {
      return participants.get(sessionId) ?? [];
    },
  };

  return Object.assign(store, { sessions, members, participants, contacts });
}

function clone(call: SimCall): SimCall {
  return {
    ...call,
    script: {
      ...call.script,
      beats: call.script.beats.map((beat) => ({ ...beat })),
      voicemail_posted_attempts: [...call.script.voicemail_posted_attempts],
      call_waiting: [...call.script.call_waiting],
      redial_openings: call.script.redial_openings ? [...call.script.redial_openings] : undefined,
    },
    recipientUserIds: call.recipientUserIds ? [...call.recipientUserIds] : null,
    recipientTeams: [...call.recipientTeams],
    declinedUserIds: [...call.declinedUserIds],
    beatsDone: [...call.beatsDone],
    rungUserIds: [...call.rungUserIds],
  };
}
