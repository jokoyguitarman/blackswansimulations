import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

interface BriefingViewProps {
  sessionId: string;
}

export const BriefingView = ({ sessionId }: BriefingViewProps) => {
  const [briefing, setBriefing] = useState<{
    general_briefing: string;
    role_specific_briefing: string | null;
    scenario_title: string;
    user_role: string | null;
    team_name?: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadBriefing();
  }, [sessionId]);

  const loadBriefing = async () => {
    try {
      const result = await api.briefing.get(sessionId);
      setBriefing(result.data);
    } catch (error) {
      console.error('Failed to load briefing:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-muted animate-pulse">Loading briefing…</p>
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-danger">Failed to load briefing</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* General Briefing */}
      <div className="military-border p-6 bg-surface">
        <h3 className="text-lg terminal-text mb-4 text-ink">
          General briefing — {briefing.scenario_title}
        </h3>
        <div className="prose prose-invert max-w-none">
          <div className="text-sm terminal-text text-ink whitespace-pre-wrap">
            {briefing.general_briefing}
          </div>
        </div>
      </div>

      {/* Team / role-specific briefing */}
      {briefing.role_specific_briefing && (briefing.team_name || briefing.user_role) && (
        <div className="military-border p-6 bg-accent/10 border-accent">
          <h3 className="text-lg terminal-text mb-4 text-ink">
            Team brief —{' '}
            {(briefing.team_name || briefing.user_role || '')
              .toString()
              .toUpperCase()
              .replace('_', ' ')}
          </h3>
          <div className="prose prose-invert max-w-none">
            <div className="text-sm terminal-text text-ink whitespace-pre-wrap">
              {briefing.role_specific_briefing}
            </div>
          </div>
        </div>
      )}

      {!briefing.role_specific_briefing && (briefing.team_name || briefing.user_role) && (
        <div className="military-border p-4 bg-surface">
          <p className="text-xs terminal-text text-muted">
            No additional briefing provided for your team.
          </p>
        </div>
      )}

      {/* Volunteer / Insider note */}
      <div className="military-border p-4 bg-surface">
        <p className="text-sm terminal-text text-ink">
          You have a Volunteer in the field you can message through the chat. The contact appears as{' '}
          <strong>the Insider</strong>.
        </p>
      </div>
    </div>
  );
};
