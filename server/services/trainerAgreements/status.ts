import type { TrainerAgreementStatus } from '../../../shared/trainerAgreements.js';

export type AgreementAction = 'edit_details' | 'upload' | 'approve' | 'request_changes' | 'reject';

const ALLOWED_FROM: Record<AgreementAction, readonly TrainerAgreementStatus[]> = {
  edit_details: ['awaiting_signature', 'changes_requested'],
  upload: ['awaiting_signature', 'changes_requested'],
  approve: ['submitted'],
  request_changes: ['submitted'],
  reject: ['awaiting_signature', 'submitted', 'changes_requested'],
};

type StatusChangingAction = Exclude<AgreementAction, 'edit_details'>;

const RESULT: Record<StatusChangingAction, TrainerAgreementStatus> = {
  upload: 'submitted',
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
};

/** Statuses from which `action` is allowed, for conditional updates (`.in('status', ...)`). */
export const statusesAllowing = (action: AgreementAction): TrainerAgreementStatus[] => [
  ...ALLOWED_FROM[action],
];

export const canPerform = (action: AgreementAction, status: TrainerAgreementStatus): boolean =>
  ALLOWED_FROM[action].includes(status);

/** Status an agreement moves to. Editing details re-issues the agreement but keeps its status. */
export const statusAfter = (action: StatusChangingAction): TrainerAgreementStatus => RESULT[action];
