import type { DraftStatus } from './types';

export const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
};

export function StatusChip({
  status,
  compact = false,
}: {
  status: DraftStatus;
  compact?: boolean;
}) {
  return (
    <span
      className={`docs-status-chip docs-status-${status}${compact ? ' docs-status-compact' : ''}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
