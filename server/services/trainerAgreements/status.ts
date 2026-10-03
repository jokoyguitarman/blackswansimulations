import type { TrainerAgreementStatus } from '../../../shared/trainerAgreements.js';

export type AgreementAction =
  | 'edit_details'
  | 'upload'
  | 'submit'
  | 'approve'
  | 'request_changes'
  | 'reject';

const ALLOWED_FROM: Record<AgreementAction, readonly TrainerAgreementStatus[]> = {
  edit_details: ['awaiting_signature', 'changes_requested'],
  // Uploading only saves the signed copy; submitting is the separate step that sends it.
  upload: ['awaiting_signature', 'changes_requested'],
  submit: ['awaiting_signature', 'changes_requested'],
  approve: ['submitted'],
  request_changes: ['submitted'],
  reject: ['awaiting_signature', 'submitted', 'changes_requested'],
};

type StatusChangingAction = Exclude<AgreementAction, 'edit_details' | 'upload'>;

const RESULT: Record<StatusChangingAction, TrainerAgreementStatus> = {
  submit: 'submitted',
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

/**
 * Status an agreement moves to. Editing details re-issues the agreement and uploading saves a
 * signed copy; neither changes the status.
 */
export const statusAfter = (action: StatusChangingAction): TrainerAgreementStatus => RESULT[action];
