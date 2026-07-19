import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { ClassifiedBlocker } from '../ClassifiedBlocker';

export function AgencyDashboard() {
  const { role, blindSpots, roleDescription } = useRoleVisibility();

  return (
    <div className="space-y-6">
      {/* Role-specific header */}
      <div className="border-b border-border pb-4 mb-6">
        <h2 className="text-2xl font-extrabold text-brand mb-1 capitalize">
          {role.replace(/_/g, ' ')} command center
        </h2>
        <p className="text-sm text-muted">{roleDescription}</p>
      </div>

      {/* Blind spots warning */}
      {blindSpots.length > 0 && (
        <div className="border-l-4 border-warning bg-warning/10 rounded-md p-4 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 bg-warning rounded-full"></div>
            <span className="text-xs font-bold text-warning uppercase tracking-wide">
              Information blind spots detected
            </span>
          </div>
          <p className="text-sm text-muted mb-2">
            Your role has limited visibility. Some information requires coordination with other
            agencies.
          </p>
          <div className="text-xs text-muted">
            Hidden information types: {blindSpots.slice(0, 5).join(', ')}
            {blindSpots.length > 5 && ` +${blindSpots.length - 5} more`}
          </div>
        </div>
      )}

      {/* Role-specific information panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Visible: Incidents */}
        <ClassifiedBlocker informationType="incidents">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Active incidents
            </div>
            <div className="text-sm text-muted">No active incidents</div>
          </div>
        </ClassifiedBlocker>

        {/* Visible: Decisions */}
        <ClassifiedBlocker informationType="decisions">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Decision queue
            </div>
            <div className="text-sm text-muted">No pending decisions</div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Casualties (for most roles) */}
        <ClassifiedBlocker informationType="casualties">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Casualty reports
            </div>
            <div className="text-sm text-muted">No reports available</div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Intelligence (for most roles) */}
        <ClassifiedBlocker informationType="intelligence">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Intelligence reports
            </div>
            <div className="text-sm text-muted">No reports available</div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Public Sentiment (for most roles) */}
        <ClassifiedBlocker informationType="public_sentiment">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Public sentiment analysis
            </div>
            <div className="text-sm text-muted">No data available</div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Infrastructure Status (for most roles) */}
        <ClassifiedBlocker informationType="infrastructure_status">
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Infrastructure status
            </div>
            <div className="text-sm text-muted">No data available</div>
          </div>
        </ClassifiedBlocker>
      </div>

      {/* Communication reminder */}
      <div className="border-l-4 border-accent bg-accent/10 rounded-md p-4 mt-6">
        <div className="text-xs font-bold text-accent uppercase tracking-wide mb-2">
          Action required · inter-agency communication
        </div>
        <p className="text-sm text-muted">
          To access classified information, use communication channels to request data from
          appropriate agencies. Information sharing is critical for effective crisis coordination.
        </p>
      </div>
    </div>
  );
}
