export function TrainerDashboard() {
  return (
    <div className="space-y-6">
      {/* Trainer-specific header */}
      <div className="border-b-2 border-robotic-yellow pb-4 mb-6">
        <h2 className="text-2xl terminal-text uppercase tracking-wider mb-2">
          [DASHBOARD] Trainer Command Center
        </h2>
        <p className="text-xs terminal-text text-robotic-yellow/70">
          [STATUS] Full system visibility // Exercise oversight mode
        </p>
      </div>

      {/* Full visibility notice */}
      <div className="military-border bg-robotic-yellow/20 border-robotic-yellow p-4 mb-6">
        <div className="flex items-center space-x-2 mb-2">
          <div className="w-2 h-2 bg-robotic-yellow rounded-full animate-pulse"></div>
          <span className="text-xs terminal-text text-robotic-yellow uppercase">
            [MODE] Full System Visibility
          </span>
        </div>
        <p className="text-xs terminal-text text-robotic-yellow/70">
          As trainer, you have complete visibility into all agency activities, decisions, and blind
          spots. Use this to monitor exercise progress and provide guidance.
        </p>
      </div>

      {/* Trainer modules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="military-border bg-robotic-gray-300/50 p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            [MODULE] Scenario Management
          </div>
          <div className="text-sm terminal-text text-robotic-yellow/30">
            [STATUS] Initializing...
          </div>
        </div>

        <div className="military-border bg-robotic-gray-300/50 p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            [MODULE] Exercise Monitoring
          </div>
          <div className="text-sm terminal-text text-robotic-yellow/30">
            [STATUS] Initializing...
          </div>
        </div>

        <div className="military-border bg-robotic-gray-300/50 p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            [MODULE] AI Inject Control
          </div>
          <div className="text-sm terminal-text text-robotic-yellow/30">
            [STATUS] Initializing...
          </div>
        </div>

        <div className="military-border bg-robotic-gray-300/50 p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
            [MODULE] Analytics & AAR
          </div>
          <div className="text-sm terminal-text text-robotic-yellow/30">
            [STATUS] Initializing...
          </div>
        </div>
      </div>
    </div>
  );
}
