import { useState } from 'react';
import { api } from '../../lib/api';

interface JoinLinkPanelProps {
  sessionId: string;
  joinToken: string;
  joinEnabled: boolean;
  joinExpiresAt?: string | null;
  onUpdate?: () => void;
}

export const JoinLinkPanel = ({
  sessionId,
  joinToken: initialToken,
  joinEnabled: initialEnabled,
  joinExpiresAt: initialExpiresAt,
  onUpdate,
}: JoinLinkPanelProps) => {
  const [joinToken, setJoinToken] = useState(initialToken);
  const [joinEnabled, setJoinEnabled] = useState(initialEnabled);
  const [joinExpiresAt, setJoinExpiresAt] = useState(initialExpiresAt);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const joinUrl = `${window.location.origin}/join/${joinToken}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = joinUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegenerate = async () => {
    if (!confirm('Regenerate the join link? The current link will stop working immediately.')) {
      return;
    }
    setLoading(true);
    try {
      const result = await api.join.regenerateToken(sessionId);
      setJoinToken(result.data.join_token);
      setJoinEnabled(result.data.join_enabled);
      setJoinExpiresAt(result.data.join_expires_at);
      onUpdate?.();
    } catch (err) {
      console.error('Failed to regenerate join link:', err);
      alert('Failed to regenerate join link');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async () => {
    setLoading(true);
    try {
      const result = await api.join.toggleEnabled(sessionId, !joinEnabled);
      setJoinEnabled(result.data.join_enabled);
      onUpdate?.();
    } catch (err) {
      console.error('Failed to toggle join link:', err);
      alert('Failed to update join link');
    } finally {
      setLoading(false);
    }
  };

  const expiresDate = joinExpiresAt ? new Date(joinExpiresAt) : null;
  const isExpired = expiresDate ? expiresDate < new Date() : false;

  return (
    <div className="military-border p-4 bg-surface mt-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm terminal-text text-success">Join link</h3>
        <span
          className={`text-xs terminal-text px-2 py-1 border ${
            joinEnabled && !isExpired ? 'border-success text-success' : 'border-danger text-danger'
          }`}
        >
          {!joinEnabled ? 'DISABLED' : isExpired ? 'EXPIRED' : 'ACTIVE'}
        </span>
      </div>

      {/* URL Display */}
      <div className="bg-surface-2 border border-border p-3 mb-3 break-all">
        <code className="text-xs terminal-text text-ink">{joinUrl}</code>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 flex-wrap mb-3">
        <button
          onClick={handleCopy}
          disabled={loading}
          className="military-button px-4 py-2 text-xs flex-1 min-w-[100px]"
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <button
          onClick={handleRegenerate}
          disabled={loading}
          className="military-button px-4 py-2 text-xs flex-1 min-w-[100px]"
        >
          {loading ? '…' : 'Regenerate'}
        </button>
        <button
          onClick={handleToggle}
          disabled={loading}
          className={`military-button px-4 py-2 text-xs flex-1 min-w-[100px] ${
            joinEnabled ? 'border-danger/50 text-danger' : 'border-success/50 text-success'
          }`}
        >
          {loading ? '…' : joinEnabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      {/* Expiry Info */}
      {expiresDate && (
        <div className="text-xs terminal-text text-muted">
          {isExpired ? 'Expired' : 'Expires'}: {expiresDate.toLocaleString()}
        </div>
      )}

      <p className="text-xs terminal-text text-muted mt-2">
        Share this link with participants. They can join without an account.
      </p>
    </div>
  );
};
