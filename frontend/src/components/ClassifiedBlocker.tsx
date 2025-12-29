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
    <div className="military-border border-robotic-orange p-6 relative overflow-hidden">
      {/* Redacted overlay pattern */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255, 107, 53, 0.1) 10px, rgba(255, 107, 53, 0.1) 20px)',
        }}
      />
      <div className="relative z-10 text-center">
        <div className="classified-stamp text-3xl mb-2">CLASSIFIED</div>
        <div className="text-xs terminal-text text-robotic-orange uppercase mb-2">
          [ACCESS_DENIED] Insufficient Clearance Level
        </div>
        <div className="text-xs terminal-text text-robotic-orange/70 mb-4">
          Information type: <code className="bg-robotic-gray-300/50 px-1">{informationType}</code>
        </div>
        {showRequestAccess && (
          <div className="text-xs terminal-text text-robotic-yellow/70">
            [ACTION_REQUIRED] Request access from appropriate agency via communication channels
          </div>
        )}
        <div className="mt-4 text-xs terminal-text text-robotic-gray-50">
          [ROLE] {role.toUpperCase()}
        </div>
      </div>
    </div>
  );
}
