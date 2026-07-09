import { useRoleVisibility } from '../hooks/useRoleVisibility';
import type { InformationType } from '@shared/roleVisibility';

interface ClassifiedBlockerProps {
  informationType: InformationType;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showRequestAccess?: boolean;
}

/**
 * Component that hides information based on role visibility
 * Shows "CLASSIFIED" or "REQUEST ACCESS" for blind spots
 */
export function ClassifiedBlocker({
  informationType,
  children,
  fallback,
  showRequestAccess = true,
}: ClassifiedBlockerProps) {
  const { canSee, role } = useRoleVisibility();

  if (canSee(informationType)) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <div className="bg-surface-2 border border-border rounded-lg p-6 relative overflow-hidden">
      <div className="relative z-10 text-center">
        <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-accent mb-3">
          <span aria-hidden>🔒</span> Classified
        </div>
        <div className="text-sm font-semibold text-ink mb-1">Insufficient clearance level</div>
        <div className="text-xs text-muted mb-4">
          Information type:{' '}
          <code className="bg-surface border border-border rounded px-1.5 py-0.5">
            {informationType}
          </code>
        </div>
        {showRequestAccess && (
          <div className="text-xs text-muted">
            Request access from the appropriate agency via communication channels.
          </div>
        )}
        <div className="mt-4 text-xs text-muted capitalize">Role: {role}</div>
      </div>
    </div>
  );
}
