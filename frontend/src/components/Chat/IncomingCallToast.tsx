import { useEffect, useState } from 'react';

interface IncomingCallToastProps {
  callId: string;
  callerName: string;
  onAccept: (callId: string) => void;
  onReject: (callId: string) => void;
  variant?: 'terminal' | 'whatsapp';
}

const AUTO_REJECT_SECONDS = 30;

export function IncomingCallToast({
  callId,
  callerName,
  onAccept,
  onReject,
  variant = 'terminal',
}: IncomingCallToastProps) {
  const [countdown, setCountdown] = useState(AUTO_REJECT_SECONDS);
  const isWA = variant === 'whatsapp';

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          onReject(callId);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [callId, onReject]);

  if (isWA) {
    return (
      <div className="fixed top-4 right-4 z-[9999]">
        <div className="bg-wa-header border border-wa-teal rounded-2xl p-4 shadow-2xl shadow-black/40 min-w-[280px] wa-chat-font">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-11 h-11 rounded-full bg-wa-teal flex items-center justify-center">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="text-sm text-wa-text font-semibold">Incoming Voice Call</div>
              <div className="text-xs text-wa-text-secondary">{callerName}</div>
            </div>
            <div className="text-xs text-wa-text-secondary">{countdown}s</div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => onAccept(callId)}
              className="flex-1 py-2.5 text-sm font-medium rounded-full bg-wa-teal text-white hover:bg-wa-teal-light transition-all"
            >
              Accept
            </button>
            <button
              onClick={() => onReject(callId)}
              className="flex-1 py-2.5 text-sm font-medium rounded-full bg-red-500 text-white hover:bg-red-600 transition-all"
            >
              Decline
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed top-4 right-4 z-[9999] animate-pulse">
      <div className="bg-surface border-2 border-success rounded-lg p-4 shadow-2xl shadow-success/20 min-w-[280px]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center text-xl">
            📞
          </div>
          <div className="flex-1">
            <div className="text-sm terminal-text text-success font-medium">
              Incoming voice call
            </div>
            <div className="text-xs text-ink">{callerName}</div>
          </div>
          <div className="text-xs text-muted">{countdown}s</div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onAccept(callId)}
            className="flex-1 py-2 text-xs terminal-text border border-success text-success hover:bg-success/20 rounded transition-all"
          >
            Accept
          </button>
          <button
            onClick={() => onReject(callId)}
            className="flex-1 py-2 text-xs terminal-text border border-danger text-danger hover:bg-danger/20 rounded transition-all"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
