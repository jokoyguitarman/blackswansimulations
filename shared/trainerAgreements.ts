/**
 * Prophyion Consultant Agreement records, shared by the server and the frontend.
 *
 * A participant who wants trainer access files an 'application'; a trainer who already has
 * access files their signed agreement as 'existing_trainer'. Only an admin approving an
 * application grants the trainer role.
 */

export type TrainerAgreementStatus =
  | 'awaiting_signature'
  | 'submitted'
  | 'changes_requested'
  | 'approved'
  | 'rejected';

export type TrainerAgreementPurpose = 'application' | 'existing_trainer';

/** Statuses of a row still in progress. A user has at most one such row. */
export const OPEN_AGREEMENT_STATUSES: readonly TrainerAgreementStatus[] = [
  'awaiting_signature',
  'submitted',
  'changes_requested',
];

export const isOpenAgreementStatus = (status: TrainerAgreementStatus): boolean =>
  OPEN_AGREEMENT_STATUSES.includes(status);

/** Values the platform writes into the agreement template. */
export type AgreementFieldKey =
  | 'full_name'
  | 'email'
  | 'contact_number'
  | 'address'
  | 'agreement_date';

/** Public description of the agreement version currently issued. */
export interface AgreementInfo {
  version: string;
  title: string;
  pageCount: number;
  fields: AgreementFieldKey[];
}

/** An agreement as its owner sees it. */
export interface TrainerAgreement {
  id: string;
  purpose: TrainerAgreementPurpose;
  status: TrainerAgreementStatus;
  agreement_version: string;
  reference: string;
  full_name: string;
  email: string;
  contact_number: string | null;
  address: string | null;
  organisation: string | null;
  issued_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  has_signed_copy: boolean;
  created_at: string;
  updated_at: string;
}

export interface MyAgreementResponse {
  agreement: AgreementInfo;
  /** The user's most recent row of any status. */
  current: TrainerAgreement | null;
  /** The user's most recent approved row: the agreement on file. */
  onFile: TrainerAgreement | null;
}

/** An agreement as the Business console sees it. */
export interface AdminTrainerAgreement extends TrainerAgreement {
  user_id: string;
  /** The account's role right now, which can differ from when it applied. */
  user_role: string | null;
  signed_file_pages: number | null;
  /** Null when the upload had no text layer (a scan) or was attached by an admin. */
  signed_file_has_reference: boolean | null;
  /** Page count of the issued agreement version, for comparison with the upload. */
  expected_pages: number | null;
  was_attached: boolean;
  reviewed_by_name: string | null;
  decision_emailed_at: string | null;
}

export type AdminAgreementView = 'review' | 'in_progress' | 'decided';

export interface AdminAgreementList {
  items: AdminTrainerAgreement[];
  counts: Record<AdminAgreementView, number>;
}

export type AgreementSummaryStatus =
  | 'signed'
  | 'under_review'
  | 'changes_requested'
  | 'awaiting_signature'
  | 'none';

/** One-line agreement state for a trainer, for badges. */
export interface AgreementSummary {
  status: AgreementSummaryStatus;
  id: string | null;
  version: string | null;
  signed_at: string | null;
}

/** What applicants are told about how long review takes. */
export const APPLICATION_REVIEW_TIME = 'five business days';

interface SummarisableRow {
  id: string;
  status: TrainerAgreementStatus;
  agreement_version: string;
  reviewed_at: string | null;
  created_at: string;
}

/**
 * Collapse a user's agreement rows into the state shown on badges. An agreement on file wins
 * over anything in progress, so a trainer re-signing a newer version still shows as signed.
 */
export function summariseAgreement(rows: readonly SummarisableRow[]): AgreementSummary {
  const latest = (status: TrainerAgreementStatus) =>
    rows
      .filter((r) => r.status === status)
      .sort((a, b) =>
        (b.reviewed_at ?? b.created_at).localeCompare(a.reviewed_at ?? a.created_at),
      )[0];

  const approved = latest('approved');
  if (approved) {
    return {
      status: 'signed',
      id: approved.id,
      version: approved.agreement_version,
      signed_at: approved.reviewed_at,
    };
  }
  const inProgress: Array<[TrainerAgreementStatus, AgreementSummaryStatus]> = [
    ['submitted', 'under_review'],
    ['changes_requested', 'changes_requested'],
    ['awaiting_signature', 'awaiting_signature'],
  ];
  for (const [rowStatus, summaryStatus] of inProgress) {
    const row = latest(rowStatus);
    if (row) {
      return { status: summaryStatus, id: row.id, version: row.agreement_version, signed_at: null };
    }
  }
  return { status: 'none', id: null, version: null, signed_at: null };
}
