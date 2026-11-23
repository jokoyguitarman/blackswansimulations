import type { NormalisedReview, RegistryEntry, ReviewState } from './types.js';
import { USE_OF_FORCE_STEMS } from './registry.js';

/** Spec section 11.3. An R3 review by this person on this date satisfies free-text roles except use of force. */
export const OWNER_APPROVAL = { reviewer: 'Jokoy Tabbada', date: '2026-11-22' } as const;

export const OWNER_QUALIFICATION =
  'Project owner (Prophyion); reviewed and approved all knowledge research seed files';

export const FORCE_ROLES = ['legal', 'police_service', 'military_service'] as const;
export type ForceRole = (typeof FORCE_ROLES)[number];

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isFullDate(value: unknown): value is string {
  return typeof value === 'string' && FULL_DATE.test(value);
}

export function isForceRole(value: string): value is ForceRole {
  return (FORCE_ROLES as readonly string[]).includes(value);
}

/** A required-role string is a use-of-force requirement when any alternative is one of the three roles. */
export function isUseOfForceRequirement(roleText: string): boolean {
  return roleText
    .split(/\s+or\s+/i)
    .map((part) => part.trim())
    .some((part) => isForceRole(part));
}

export function fileReleased(document: Record<string, unknown>, entry: RegistryEntry): boolean {
  if (entry.format === 'doctrine_seed_v1' || entry.format === 'agency_register_v1') {
    const review = asRecord(document.review);
    const status = review?.status;
    return status === 'approved_for_import' || status === 'rejected' || status === 'amended';
  }
  const status = document.review_status;
  const headerReleased = status === 'reviewed' || status === 'approved';
  if (!headerReleased) return false;
  if ('seed_status' in document) {
    const seed = document.seed_status;
    return seed === undefined || seed === 'REVIEWED';
  }
  return true;
}

export function normaliseReview(
  document: Record<string, unknown>,
  entry: RegistryEntry,
  recordKey: string,
  row: Record<string, unknown> | null,
): NormalisedReview {
  const released = fileReleased(document, entry);
  const r3 = entry.format === 'doctrine_seed_v1' || entry.format === 'agency_register_v1';
  const fileReview = asRecord(document.review);
  const rowReview = row ? asRecord(row.review) : null;
  const rowDecision = fileReview ? asRecord(asRecord(fileReview.row_decisions)?.[recordKey]) : null;

  if (!released) {
    return pending(storedFrom(rowReview, fileReview, rowDecision), 'file not released');
  }
  if (r3) return normaliseR3(fileReview);
  if (rowReview && hasOwnDecision(rowReview)) return fromParts(rowReview, rowReview);
  if (rowDecision) return fromFileLevel(fileReview, rowDecision);
  return pending(storedFrom(rowReview, fileReview, null), 'no decision');
}

function normaliseR3(review: Record<string, unknown> | null): NormalisedReview {
  const status = review?.status;
  const decision: ReviewState | null =
    status === 'approved_for_import'
      ? 'approved'
      : status === 'amended'
        ? 'amended'
        : status === 'rejected'
          ? 'rejected'
          : null;
  const name = stringOrNull(review?.reviewer);
  const qualification = stringOrNull(review?.reviewer_role);
  const date = stringOrNull(review?.reviewed_at);
  const notes = stringOrNull(review?.notes);
  const stored = review ? { ...review } : {};
  if (!decision) return pending(stored, 'no decision');
  return finish(
    decision,
    name,
    qualification,
    date,
    notes,
    qualification,
    asArray(review?.history),
    stringList(review?.required_reviewer_roles),
    stored,
  );
}

function fromParts(
  source: Record<string, unknown>,
  decisionSource: Record<string, unknown>,
): NormalisedReview {
  const decision = decisionOf(decisionSource.decision);
  const name = stringOrNull(source.reviewer_name);
  const qualification = stringOrNull(source.reviewer_qualification);
  const date = stringOrNull(source.decided_on ?? source.reviewed_on);
  const notes = stringOrNull(decisionSource.notes ?? source.notes);
  if (!decision) return pending({ ...source }, 'no decision');
  return finish(decision, name, qualification, date, notes, null, [], [], {
    ...source,
    ...decisionSource,
  });
}

function fromFileLevel(
  fileReview: Record<string, unknown> | null,
  decisionSource: Record<string, unknown>,
): NormalisedReview {
  const decision = decisionOf(decisionSource.decision);
  const name = stringOrNull(fileReview?.reviewer_name);
  const qualification = stringOrNull(fileReview?.reviewer_qualification);
  const date = stringOrNull(fileReview?.reviewed_on ?? fileReview?.decided_on);
  const notes = stringOrNull(decisionSource.notes);
  const stored = {
    ...(fileReview ?? {}),
    decision,
    notes,
    reviewer_name: name,
    reviewer_qualification: qualification,
    decided_on: date,
  };
  if (!decision) return pending(stored, 'no decision');
  return finish(decision, name, qualification, date, notes, null, [], [], stored);
}

function finish(
  decision: ReviewState,
  name: string | null,
  qualification: string | null,
  date: string | null,
  notes: string | null,
  role: string | null,
  history: unknown[],
  requiredRoles: string[],
  stored: Record<string, unknown>,
): NormalisedReview {
  const dateOk = isFullDate(date);
  const identityOk = Boolean(
    name && name.length >= 2 && qualification && qualification.length >= 2 && dateOk,
  );
  const noteOk = decision !== 'amended' || Boolean(notes && notes.length > 0);
  if (decision === 'rejected') {
    return {
      state: 'rejected',
      reviewerName: name,
      reviewerQualification: qualification,
      decidedOn: dateOk ? date : null,
      notes,
      reviewerRole: role,
      history,
      requiredRoles,
      stored,
    };
  }
  if (!identityOk || !noteOk) {
    return pending(stored, 'incomplete');
  }
  return {
    state: decision,
    reviewerName: name,
    reviewerQualification: qualification,
    decidedOn: date,
    notes,
    reviewerRole: role,
    history,
    requiredRoles,
    stored,
  };
}

function pending(stored: Record<string, unknown>, _why: string): NormalisedReview {
  return {
    state: 'pending',
    reviewerName: stringOrNull(stored.reviewer_name) ?? stringOrNull(stored.reviewer),
    reviewerQualification:
      stringOrNull(stored.reviewer_qualification) ?? stringOrNull(stored.reviewer_role),
    decidedOn: null,
    notes: stringOrNull(stored.notes),
    reviewerRole: stringOrNull(stored.reviewer_role),
    history: asArray(stored.history),
    requiredRoles: stringList(stored.required_reviewer_roles),
    stored,
  };
}

function hasOwnDecision(review: Record<string, unknown>): boolean {
  return decisionOf(review.decision) !== null;
}

function decisionOf(value: unknown): ReviewState | null {
  if (value === 'approved' || value === 'amended' || value === 'rejected') return value;
  return null;
}

function storedFrom(
  rowReview: Record<string, unknown> | null,
  fileReview: Record<string, unknown> | null,
  rowDecision: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(fileReview ?? {}), ...(rowReview ?? {}), ...(rowDecision ?? {}) };
}

/** Owner approval on this date stands in for free-text required roles other than use of force. */
export function ownerApprovalSatisfies(review: NormalisedReview, roleText: string): boolean {
  if (isUseOfForceRequirement(roleText)) return forceRoleSatisfied(review, roleText);
  return isOwnerReview(review) || roleMatches(review, roleText);
}

export function isOwnerReview(review: NormalisedReview): boolean {
  return (
    review.reviewerName === OWNER_APPROVAL.reviewer &&
    review.decidedOn === OWNER_APPROVAL.date &&
    (review.state === 'approved' || review.state === 'amended')
  );
}

export function forceRoleSatisfied(review: NormalisedReview, roleText?: string): boolean {
  const needed = roleText
    ? roleText
        .split(/\s+or\s+/i)
        .map((part) => part.trim())
        .filter(isForceRole)
    : [...FORCE_ROLES];
  if (needed.length === 0) return false;
  if (review.reviewerRole && needed.includes(review.reviewerRole as ForceRole)) return true;
  return review.history.some((entry) => {
    const row = asRecord(entry);
    if (!row) return false;
    const role = stringOrNull(row.reviewer_role);
    const decision = row.decision;
    const approved =
      decision === 'approved' || decision === 'approved_for_import' || decision === 'amended';
    return Boolean(role && approved && needed.includes(role as ForceRole));
  });
}

function roleMatches(review: NormalisedReview, roleText: string): boolean {
  return review.reviewerRole === roleText;
}

export function contentWithoutUseOfForce(content: Record<string, unknown>): {
  content: Record<string, unknown>;
  withheld: boolean;
} {
  if (!('use_of_force' in content)) return { content, withheld: false };
  const next = { ...content };
  delete next.use_of_force;
  return { content: next, withheld: true };
}

export function doctrineStem(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

export function isUseOfForceDoctrine(relativePath: string): boolean {
  return (USE_OF_FORCE_STEMS as readonly string[]).includes(doctrineStem(relativePath));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
