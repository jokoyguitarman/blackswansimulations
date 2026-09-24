import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  APPLICATION_REVIEW_TIME,
  isOpenAgreementStatus,
  type MyAgreementResponse,
} from '@shared/trainerAgreements';

type Tone = 'info' | 'warning' | 'success' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  info: 'border-accent bg-accent/10',
  warning: 'border-warning bg-warning/10',
  success: 'border-success bg-success/10',
  danger: 'border-danger bg-danger/10',
};

export const formatAgreementDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

interface Props {
  mine: MyAgreementResponse;
  role: string | undefined;
  /** Also show an agreement already on file (the dashboard only shows what needs doing). */
  showOnFile?: boolean;
  /** Signed up as a consultant but has not saved their agreement details yet. */
  applying?: boolean;
  children?: ReactNode;
}

/** Where the user's Consultant Agreement stands, with the next step. Renders nothing when idle. */
export function AgreementStatusCard({
  mine,
  role,
  showOnFile = false,
  applying = false,
  children,
}: Props) {
  const { current, onFile } = mine;
  const isTrainer = role === 'trainer';
  const open = current && isOpenAgreementStatus(current.status) ? current : null;

  let tone: Tone;
  let title: string;
  let body: string;
  let action: { to: string; label: string; reload?: boolean } | null = null;

  if (open?.status === 'awaiting_signature') {
    tone = 'info';
    title = isTrainer
      ? 'Please sign the Prophyion Consultant Agreement'
      : 'Finish your consultant application';
    body = 'Download your agreement, sign it, and upload the signed copy.';
    action = { to: '/apply', label: 'Continue' };
  } else if (open?.status === 'changes_requested') {
    tone = 'warning';
    title = 'We need a change to your agreement';
    body =
      open.review_note || 'Please read the note from our reviewer and upload a new signed copy.';
    action = { to: '/apply', label: 'Update and re-upload' };
  } else if (open?.status === 'submitted') {
    tone = 'info';
    title = isTrainer
      ? 'Your signed agreement is being reviewed'
      : 'Your application is being reviewed';
    body = `Submitted ${formatAgreementDate(open.submitted_at)}. We aim to respond within ${APPLICATION_REVIEW_TIME} and will email you.`;
    action = { to: '/apply', label: 'View' };
  } else if (onFile && role === 'participant') {
    tone = 'success';
    title = 'Your consultant application is approved';
    body = 'Your account now has consultant access.';
    action = { to: '/clients', label: 'Open consultant tools', reload: true };
  } else if (onFile) {
    if (!showOnFile) return null;
    tone = 'success';
    title = 'Your signed agreement is on file';
    body = `Version ${onFile.agreement_version}, accepted ${formatAgreementDate(onFile.reviewed_at)}.`;
  } else if (current?.status === 'rejected' && !isTrainer) {
    tone = 'danger';
    title = 'Your consultant application was not approved';
    body = current.review_note || 'If you have questions, reply to the email we sent you.';
  } else if (isTrainer) {
    tone = 'warning';
    title = 'Please sign the Prophyion Consultant Agreement';
    body = 'Every Prophyion consultant signs it. Your access continues while we review it.';
    action = { to: '/apply', label: 'Sign the agreement' };
  } else if (applying && role === 'participant' && !current) {
    tone = 'info';
    title = 'Finish your consultant application';
    body = 'Add your details to get your agreement, then sign it and upload the signed copy.';
    action = { to: '/apply', label: 'Continue' };
  } else {
    return null;
  }

  return (
    <div className={`border-l-4 p-4 rounded-md ${TONE_CLASS[tone]}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-ink">{title}</div>
          <p className="text-xs text-muted mt-1 whitespace-pre-line">{body}</p>
        </div>
        {action &&
          (action.reload ? (
            <button
              onClick={() => {
                window.location.href = action.to;
              }}
              className="military-button px-4 py-2 text-xs shrink-0"
            >
              {action.label}
            </button>
          ) : (
            <Link to={action.to} className="military-button px-4 py-2 text-xs shrink-0">
              {action.label}
            </Link>
          ))}
      </div>
      {children}
    </div>
  );
}
