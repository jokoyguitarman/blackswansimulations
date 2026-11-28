/**
 * Trainer-console view of the AI director. Pure: the route and the panel
 * both render this shape.
 */

import type { DirectorMode } from './directorModes.js';

export interface DirectorFairnessBar {
  team: string;
  negative: number;
  share: number;
  over: boolean;
  /** Filled cells in a four-cell bar. */
  filled: number;
}

export interface DirectorPanelCard {
  id: string;
  seq: number;
  minute: number;
  team: string;
  app: string;
  sender: string;
  severity: string;
  kind: string;
  title: string;
  content: string;
  reason: string;
  checks: string;
  warnings: string[];
  /** Seconds until auto-publish. Null when the row needs approval. */
  countdownSeconds: number | null;
  countdownLabel: string | null;
  needsApproval: boolean;
}

export interface DirectorPanelModel {
  enabled: boolean;
  mode: DirectorMode;
  modeMax: DirectorMode;
  scenarioMode: DirectorMode | null;
  sessionMode: DirectorMode | null;
  paused: boolean;
  budgetUsed: number;
  budgetLimit: number;
  tolerance: number;
  fairness: DirectorFairnessBar[];
  cards: DirectorPanelCard[];
}

export interface DirectorPanelProposal {
  id: string;
  seq: number;
  minute: number;
  status: string;
  reason: string | null;
  autoPublishAt: string | null;
  proposal: {
    kind?: string;
    title?: string;
    content?: string;
    severity?: string;
    app?: string;
    target_teams?: string[];
    sender?: { stakeholder_id?: string; npc_handle?: string };
  } | null;
  guardrails: Array<{ id: string; ok: boolean; detail: string; warning?: boolean }>;
  consistencyStatus: string | null;
}

export interface DirectorPanelInput {
  enabled: boolean;
  mode: DirectorMode;
  modeMax: DirectorMode;
  scenarioMode: DirectorMode | null;
  sessionMode: DirectorMode | null;
  paused: boolean;
  budgetUsed: number;
  budgetLimit: number;
  tolerance: number;
  fairness: Array<{ team: string; negative: number; share: number; over: boolean }>;
  proposals: DirectorPanelProposal[];
  stakeholderNames?: Record<string, string>;
  now: Date;
}

export function fairnessFilled(negative: number): number {
  if (!Number.isFinite(negative) || negative <= 0) return 0;
  return Math.max(0, Math.min(4, Math.round(negative)));
}

export function countdownLabel(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function directorPanel(input: DirectorPanelInput): DirectorPanelModel {
  const now = input.now.getTime();
  const cards = input.enabled
    ? input.proposals
        .filter((row) => row.status === 'proposed' && row.proposal)
        .map((row) => cardOf(row, input.stakeholderNames ?? {}, now))
    : [];
  return {
    enabled: input.enabled,
    mode: input.mode,
    modeMax: input.modeMax,
    scenarioMode: input.scenarioMode,
    sessionMode: input.sessionMode,
    paused: input.paused,
    budgetUsed: input.budgetUsed,
    budgetLimit: input.budgetLimit,
    tolerance: input.tolerance,
    fairness: input.fairness.map((row) => ({ ...row, filled: fairnessFilled(row.negative) })),
    cards,
  };
}

function cardOf(
  row: DirectorPanelProposal,
  names: Record<string, string>,
  now: number,
): DirectorPanelCard {
  const proposal = row.proposal ?? {};
  const due = row.autoPublishAt ? Date.parse(row.autoPublishAt) : NaN;
  const countdownSeconds = Number.isFinite(due) ? Math.max(0, (due - now) / 1000) : null;
  const warnings = row.guardrails.filter((item) => item.warning).map((item) => item.detail);
  const failed = row.guardrails.find((item) => !item.ok && !item.warning);
  const consistency = row.consistencyStatus;
  const checks = failed
    ? failed.detail
    : warnings.length > 0
      ? `Passed with warnings${consistency ? ` (consistency: ${consistency})` : ''}`
      : `All checks passed${consistency ? ` (consistency: ${consistency})` : ''}`;
  const senderId = proposal.sender?.stakeholder_id;
  const sender = senderId
    ? (names[senderId] ?? senderId)
    : (proposal.sender?.npc_handle ?? 'Unknown sender');
  return {
    id: row.id,
    seq: row.seq,
    minute: row.minute,
    team: (proposal.target_teams ?? []).join(', ') || '—',
    app: proposal.app ?? 'email',
    sender,
    severity: proposal.severity ?? 'low',
    kind: proposal.kind ?? 'consequence',
    title: proposal.title ?? '',
    content: proposal.content ?? '',
    reason: row.reason ?? '',
    checks,
    warnings,
    countdownSeconds,
    countdownLabel: countdownSeconds == null ? null : countdownLabel(countdownSeconds),
    needsApproval: countdownSeconds == null,
  };
}
