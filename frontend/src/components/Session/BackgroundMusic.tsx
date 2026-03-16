import { useState, useEffect, useRef } from 'react';

const STORAGE_KEY_VOLUME = 'bgm-volume';
const STORAGE_KEY_MUTED = 'bgm-muted';

interface BackgroundMusicProps {
  src: string;
}

export function BackgroundMusic({ src }: BackgroundMusicProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [volume, setVolume] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY_VOLUME);
    return stored !== null ? parseFloat(stored) : 0.5;
  });
  const [isMuted, setIsMuted] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_MUTED) === 'true';
  });
  const [needsInteraction, setNeedsInteraction] = useState(false);

  useEffect(() => {
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = isMuted ? 0 : volume;
    audioRef.current = audio;

    let cancelled = false;

    const tryPlay = async () => {
      if (cancelled) return;
      try {
        await audio.play();
        if (!cancelled) setNeedsInteraction(false);
      } catch {
        if (!cancelled) setNeedsInteraction(true);
      }
    };

    // Wait for enough data to play through, then start
    if (audio.readyState >= 4) {
      tryPlay();
    } else {
      audio.addEventListener('canplaythrough', tryPlay, { once: true });
    }

    return () => {
      cancelled = true;
      audio.removeEventListener('canplaythrough', tryPlay);
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
    localStorage.setItem(STORAGE_KEY_VOLUME, String(volume));
    localStorage.setItem(STORAGE_KEY_MUTED, String(isMuted));
  }, [volume, isMuted]);

  const handleEnableMusic = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setNeedsInteraction(false);
    } catch {
      // Still blocked — shouldn't happen after a click, but be safe
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (v > 0 && isMuted) setIsMuted(false);
  };

  const toggleMute = () => {
    setIsMuted((m) => !m);
  };

  if (needsInteraction) {
    return (
      <button
        onClick={handleEnableMusic}
        className="px-3 py-1 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 animate-pulse"
      >
        [ENABLE_MUSIC]
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggleMute}
        className="p-1 text-robotic-yellow hover:text-robotic-yellow/80 transition-colors"
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted || volume === 0 ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
        )}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={isMuted ? 0 : volume}
        onChange={handleVolumeChange}
        className="w-20 h-1 appearance-none bg-robotic-gray-200 rounded cursor-pointer accent-robotic-yellow [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-robotic-yellow [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-robotic-yellow [&::-moz-range-thumb]:border-0"
        title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
      />
    </div>
  );
}
