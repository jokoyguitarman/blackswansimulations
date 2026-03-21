import { useState } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';

interface VoiceMicButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  className?: string;
  /** When true, calls onTranscript immediately after transcription (no review step). */
  autoSend?: boolean;
}

export const VoiceMicButton = ({
  onTranscript,
  disabled,
  className = '',
  autoSend,
}: VoiceMicButtonProps) => {
  const { isRecording, isTranscribing, error, startRecording, stopRecording } = useVoiceInput();
  const [showError, setShowError] = useState(false);

  const handleClick = async () => {
    if (isTranscribing) return;

    if (isRecording) {
      try {
        const text = await stopRecording();
        if (text) onTranscript(text);
      } catch {
        setShowError(true);
        setTimeout(() => setShowError(false), 3000);
      }
    } else {
      try {
        setShowError(false);
        await startRecording();
      } catch {
        setShowError(true);
        setTimeout(() => setShowError(false), 3000);
      }
    }
  };

  const title = isTranscribing
    ? 'Transcribing...'
    : isRecording
      ? `Release to ${autoSend ? 'send' : 'stop'}`
      : 'Click to speak';

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isTranscribing}
        title={title}
        className={`
          military-button px-3 py-2 flex items-center justify-center transition-all
          ${isRecording ? 'bg-red-900/60 border-red-500 text-red-400' : ''}
          ${isTranscribing ? 'opacity-60 cursor-wait' : ''}
          ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
        `}
      >
        {isTranscribing ? (
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <span className="relative">
            {/* Walkie-talkie icon */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="7" y="6" width="10" height="14" rx="2" />
              <rect x="9" y="8" width="6" height="4" rx="1" opacity="0.4" />
              <circle cx="12" cy="16" r="1.5" opacity="0.6" />
              <rect x="10" y="2" width="4" height="5" rx="1" />
              <rect x="11" y="0" width="2" height="3" />
            </svg>
            {isRecording && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            )}
          </span>
        )}
      </button>

      {showError && error && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1 text-xs terminal-text text-red-400 bg-robotic-gray-400 border border-red-500/30 rounded whitespace-nowrap z-50">
          {error}
        </div>
      )}
    </div>
  );
};
