import type { CallScript, CallStatus, RedialConfig } from './callCore.js';
import type { TargetMode } from './lineCore.js';

export interface StoredScript extends CallScript {
  redial: RedialConfig;
  inject_title: string;
  inject_content: string;
  requires_response: boolean;
  ring_seconds: number;
  channel_type?: string;
  voicemail_posted_attempts: number[];
  queue_hold?: boolean;
  call_waiting: string[];
  silence_prompted?: boolean;
  response_window_minutes?: number | null;
  inject_key?: string;
  role_title?: string;
  fallback_reason?: string;
  /** The inject's target mode, kept for every later attempt. */
  inject_target_mode?: 'line' | 'role' | 'player' | 'ring_all';
  role_fallback?: 'none' | 'line' | 'line_after_minutes';
  role_fallback_minutes?: number | null;
  /** Inject delivery_config, so chain steps and root escalations reach the ledger. */
  ledger_config?: Record<string, unknown> | null;
}

export interface SimCall {
  id: string;
  sessionId: string;
  injectId: string | null;
  parentCallId: string | null;
  direction: 'inbound' | 'callback';
  stakeholderId: string | null;
  callerName: string;
  callerNumber: string | null;
  voice: string;
  script: StoredScript;
  recipientUserIds: string[] | null;
  recipientTeams: string[];
  status: CallStatus;
  mode: 'voice' | 'text' | null;
  callGroupId: string;
  attemptNo: number;
  maxAttempts: number;
  scheduledFor: string | null;
  declinedUserIds: string[];
  ringStartedAt: string;
  ringDeadlineAt: string;
  answeredBy: string | null;
  answeredAt: string | null;
  declinedBy: string | null;
  endedAt: string | null;
  endReason: string | null;
  maxSeconds: number;
  openaiCallId: string | null;
  transcriptSource: 'sideband' | 'client' | 'text' | null;
  beatsDone: string[];
  durationSeconds: number | null;
  createdAt: string;
  lineTeam: string | null;
  targetMode: TargetMode;
  targetRoleId: string | null;
  rungUserIds: string[];
  missedReason: string | null;
}

export interface StoredTurn {
  id: string;
  callId: string;
  sessionId: string;
  seq: number;
  speaker: 'npc' | 'player' | 'system';
  userId: string | null;
  text: string;
  source: 'sideband' | 'client' | 'text';
  at: string;
}

export interface CallSessionInfo {
  status: string;
  trainerId: string | null;
  startTime: string | null;
  scenarioId: string | null;
}

export interface CallStore {
  ready(): Promise<boolean>;
  insert(call: SimCall): Promise<{ call: SimCall; created: boolean } | null>;
  get(id: string): Promise<SimCall | null>;
  /** Sets connecting only while the row is still ringing. Null means the claim lost. */
  claimAnswer(id: string, userId: string, at: string): Promise<SimCall | null>;
  save(call: SimCall): Promise<void>;
  listSession(sessionId: string): Promise<SimCall[]>;
  listOpen(sessionId: string): Promise<SimCall[]>;
  listActiveSideband(): Promise<SimCall[]>;
  activeCount(sessionId: string): Promise<number>;
  durationSeconds(sessionId: string): Promise<number>;
  userBusy(sessionId: string, userId: string, exceptCallId?: string): Promise<boolean>;
  appendTurns(turns: StoredTurn[]): Promise<void>;
  turns(callId: string): Promise<StoredTurn[]>;
  recentsViewedAt(sessionId: string, userId: string): Promise<string | null>;
  setRecentsViewed(sessionId: string, userId: string, at: string): Promise<void>;
  playerContactedStakeholder(
    sessionId: string,
    stakeholderId: string,
    afterIso: string,
  ): Promise<boolean>;
  session(sessionId: string): Promise<CallSessionInfo | null>;
  teamMembers(
    sessionId: string,
    teamNames: string[],
  ): Promise<Record<string, Array<{ user_id: string; is_bot: boolean }>>>;
  participantIds(sessionId: string): Promise<string[]>;
}
