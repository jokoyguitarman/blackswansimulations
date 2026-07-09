export function TrainerDashboard() {
  return (
    <div className="space-y-6">
      {/* Trainer-specific header */}
      <div className="border-b border-border pb-4 mb-6">
        <h2 className="text-2xl font-extrabold text-brand mb-1">Trainer command center</h2>
        <p className="text-sm text-muted">Full system visibility · exercise oversight mode</p>
      </div>

      {/* Full visibility notice */}
      <div className="border-l-4 border-accent bg-accent/10 rounded-md p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 bg-accent rounded-full"></div>
          <span className="text-xs font-bold text-accent uppercase tracking-wide">
            Full system visibility
          </span>
        </div>
        <p className="text-sm text-muted">
          As trainer, you have complete visibility into all agency activities, decisions, and blind
          spots. Use this to monitor exercise progress and provide guidance.
        </p>
      </div>

      {/* Trainer modules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Scenario management
          </div>
          <div className="text-sm text-muted">Initializing…</div>
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Exercise monitoring
          </div>
          <div className="text-sm text-muted">Initializing…</div>
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            AI inject control
          </div>
          <div className="text-sm text-muted">Initializing…</div>
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Analytics &amp; AAR
          </div>
          <div className="text-sm text-muted">Initializing…</div>
        </div>
      </div>
    </div>
  );
}
