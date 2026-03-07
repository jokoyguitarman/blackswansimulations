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
        <p className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
          [LOADING_BRIEFING...]
        </p>
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-robotic-orange">[ERROR] Failed to load briefing</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* General Briefing */}
      <div className="military-border p-6 bg-robotic-gray-300">
        <h3 className="text-lg terminal-text uppercase mb-4 text-robotic-yellow">
          [GENERAL_BRIEFING] {briefing.scenario_title}
        </h3>
        <div className="prose prose-invert max-w-none">
          <div className="text-sm terminal-text text-robotic-yellow/90 whitespace-pre-wrap">
            {briefing.general_briefing}
          </div>
        </div>
      </div>

      {/* Team / role-specific briefing */}
      {briefing.role_specific_briefing && (briefing.team_name || briefing.user_role) && (
        <div className="military-border p-6 bg-robotic-yellow/10 border-robotic-yellow">
          <h3 className="text-lg terminal-text uppercase mb-4 text-robotic-yellow">
            [TEAM_BRIEF]{' '}
            {(briefing.team_name || briefing.user_role || '')
              .toString()
              .toUpperCase()
              .replace('_', ' ')}
          </h3>
          <div className="prose prose-invert max-w-none">
            <div className="text-sm terminal-text text-robotic-yellow/90 whitespace-pre-wrap">
              {briefing.role_specific_briefing}
            </div>
          </div>
        </div>
      )}

      {!briefing.role_specific_briefing && (briefing.team_name || briefing.user_role) && (
        <div className="military-border p-4 bg-robotic-gray-300">
          <p className="text-xs terminal-text text-robotic-yellow/50">
            [NO_TEAM_BRIEF] No additional briefing provided for your team.
          </p>
        </div>
      )}

      {/* Volunteer / Insider note */}
      <div className="military-border p-4 bg-robotic-gray-300">
        <p className="text-sm terminal-text text-robotic-yellow/90">
          You have a Volunteer in the field you can message through the chat. The contact appears as{' '}
          <strong>the Insider</strong>.
        </p>
      </div>
    </div>
  );
};
