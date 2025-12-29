import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { ClassifiedBlocker } from '../ClassifiedBlocker';

export function AgencyDashboard() {
  const { role, blindSpots, roleDescription } = useRoleVisibility();

  return (
    <div className="space-y-6">
      {/* Role-specific header */}
      <div className="border-b-2 border-robotic-yellow pb-4 mb-6">
        <h2 className="text-2xl terminal-text uppercase tracking-wider mb-2">
          [DASHBOARD] {role.replace(/_/g, ' ').toUpperCase()} Command Center
        </h2>
        <p className="text-xs terminal-text text-robotic-yellow/70">[STATUS] {roleDescription}</p>
      </div>

      {/* Blind spots warning */}
      {blindSpots.length > 0 && (
        <div className="military-border bg-robotic-yellow/20 border-robotic-yellow p-4 mb-6">
          <div className="flex items-center space-x-2 mb-2">
            <div className="w-2 h-2 bg-robotic-yellow rounded-full animate-pulse"></div>
            <span className="text-xs terminal-text text-robotic-yellow uppercase">
              [WARNING] Information Blind Spots Detected
            </span>
          </div>
          <p className="text-xs terminal-text text-robotic-yellow/70 mb-2">
            Your role has limited visibility. Some information requires coordination with other
            agencies.
          </p>
          <div className="mt-2 text-xs terminal-text text-robotic-yellow/50">
            Hidden information types: {blindSpots.slice(0, 5).join(', ')}
            {blindSpots.length > 5 && ` +${blindSpots.length - 5} more`}
          </div>
        </div>
      )}

      {/* Role-specific information panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Visible: Incidents */}
        <ClassifiedBlocker informationType="incidents">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Active Incidents
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No active incidents
            </div>
          </div>
        </ClassifiedBlocker>

        {/* Visible: Decisions */}
        <ClassifiedBlocker informationType="decisions">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Decision Queue
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No pending decisions
            </div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Casualties (for most roles) */}
        <ClassifiedBlocker informationType="casualties">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Casualty Reports
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No reports available
            </div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Intelligence (for most roles) */}
        <ClassifiedBlocker informationType="intelligence">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Intelligence Reports
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No reports available
            </div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Public Sentiment (for most roles) */}
        <ClassifiedBlocker informationType="public_sentiment">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Public Sentiment Analysis
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No data available
            </div>
          </div>
        </ClassifiedBlocker>

        {/* Hidden: Infrastructure Status (for most roles) */}
        <ClassifiedBlocker informationType="infrastructure_status">
          <div className="military-border bg-robotic-gray-300/50 p-4">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
              [MODULE] Infrastructure Status
            </div>
            <div className="text-sm terminal-text text-robotic-yellow/30">
              [STATUS] No data available
            </div>
          </div>
        </ClassifiedBlocker>
      </div>

      {/* Communication reminder */}
      <div className="military-border bg-robotic-yellow/20 border-robotic-yellow p-4 mt-6">
        <div className="text-xs terminal-text text-robotic-yellow uppercase mb-2">
          [ACTION_REQUIRED] Inter-Agency Communication
        </div>
        <p className="text-xs terminal-text text-robotic-yellow/70">
          To access classified information, use communication channels to request data from
          appropriate agencies. Information sharing is critical for effective crisis coordination.
        </p>
      </div>
    </div>
  );
}
