import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

/** Supabase allows one confirmation email per address about every minute. */
const COOLDOWN_SECONDS = 60;

const isRateLimit = (error: { status?: number; code?: string }) =>
  error.status === 429 || error.code === 'over_email_send_rate_limit';

interface Props {
  email: string;
  /** Wording for the button. */
  label?: string;
  /** Seconds before the first resend, for screens shown right after a link was sent. */
  initialCooldown?: number;
}

/**
 * Sends a fresh verification link. The reply is deliberately the same whether or not the address
 * has an account waiting to be verified, so this cannot be used to find out who has one. A new link
 * replaces the old one, so older links stop working.
 */
export function ResendVerification({
  email,
  label = 'Resend verification link',
  initialCooldown = 0,
}: Props) {
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(initialCooldown);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const send = async () => {
    const address = email.trim();
    if (!address) {
      setError('Enter your email address first.');
      return;
    }
    setSending(true);
    setError(null);
    const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: address });
    setSending(false);
    if (resendError) {
      if (isRateLimit(resendError)) {
        setError('A link was sent a moment ago. Please wait a minute before asking for another.');
        setSecondsLeft(COOLDOWN_SECONDS);
      } else {
        setError("We couldn't send a new link just now. Please try again in a moment.");
      }
      return;
    }
    setSentTo(address);
    setSecondsLeft(COOLDOWN_SECONDS);
  };

  const waiting = secondsLeft > 0;

  return (
    <div className="mt-3">
      {sentTo && (
        <p className="text-xs text-ink mb-2">
          If <span className="font-semibold">{sentTo}</span> is waiting to be verified, a new link
          is on its way. Use the newest link: older ones stop working.
        </p>
      )}
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      <button
        type="button"
        onClick={() => void send()}
        disabled={sending || waiting}
        className="px-4 py-2 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sending ? 'Sending…' : waiting ? `Resend available in ${secondsLeft}s` : label}
      </button>
    </div>
  );
}
