import { useEffect, useState } from 'react';

interface IncomingCallToastProps {
  callId: string;
  callerName: string;
  onAccept: (callId: string) => void;
  onReject: (callId: string) => void;
}

const AUTO_REJECT_SECONDS = 30;

export function IncomingCallToast({
  callId,
  callerName,
  onAccept,
  onReject,
}: IncomingCallToastProps) {
  const [countdown, setCountdown] = useState(AUTO_REJECT_SECONDS);

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

  return (
    <div className="fixed top-4 right-4 z-[9999] animate-pulse">
      <div className="bg-black/95 border-2 border-green-500 rounded-lg p-4 shadow-2xl shadow-green-500/20 min-w-[280px]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-green-900/50 flex items-center justify-center text-xl">
            📞
          </div>
          <div className="flex-1">
            <div className="text-sm terminal-text text-green-400 font-medium">
              Incoming Voice Call
            </div>
            <div className="text-xs text-robotic-yellow">{callerName}</div>
          </div>
          <div className="text-xs text-robotic-yellow/50">{countdown}s</div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onAccept(callId)}
            className="flex-1 py-2 text-xs terminal-text uppercase border border-green-500 text-green-400 hover:bg-green-500/20 rounded transition-all"
          >
            [ACCEPT]
          </button>
          <button
            onClick={() => onReject(callId)}
            className="flex-1 py-2 text-xs terminal-text uppercase border border-red-500 text-red-400 hover:bg-red-500/20 rounded transition-all"
          >
            [REJECT]
          </button>
        </div>
      </div>
    </div>
  );
}
