import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { ChatVariant } from './types';
import { FUNCTION_ICON, colorFor, initials } from './avatars';

interface Member {
  id: string;
  full_name: string;
  role: string;
  team_name: string | null;
  function_key: string | null;
  org_key: string | null;
  is_trainer: boolean;
}

interface MemberSheetProps {
  channelId: string;
  title: string;
  variant: ChatVariant;
  onClose: () => void;
}

export function MemberSheet({ channelId, title, variant, onClose }: MemberSheetProps) {
  const isWA = variant === 'whatsapp';
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.channels
      .getMembers(channelId)
      .then((res) => {
        if (!cancelled) setMembers(res.data || []);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load members');
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col justify-end"
      role="dialog"
      aria-label={`${title} members`}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.45)' }}
        onClick={onClose}
      />
      <div
        className={`relative rounded-t-2xl overflow-hidden flex flex-col ${isWA ? 'wa-chat-font' : 'terminal-text'}`}
        style={{
          maxHeight: '70%',
          backgroundColor: isWA ? '#111B21' : 'var(--color-surface, #0f1115)',
          color: isWA ? '#E9EDEF' : undefined,
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: isWA ? '1px solid #222E35' : '1px solid rgba(255,255,255,0.1)' }}
        >
          <div>
            <div className={isWA ? 'text-[16px] font-semibold' : 'text-sm font-semibold'}>
              {title}
            </div>
            <div className={isWA ? 'text-[12px] text-wa-text-secondary' : 'text-xs text-muted'}>
              {members ? `${members.length} member${members.length === 1 ? '' : 's'}` : 'Loading…'}
            </div>
          </div>
          <button
            onClick={onClose}
            className={isWA ? 'text-[14px] text-wa-teal' : 'text-xs text-accent'}
          >
            Done
          </button>
        </div>
        <div className="flex-1 overflow-y-auto wa-scrollbar">
          {error && (
            <p className="px-4 py-6 text-center text-[13px] text-wa-text-secondary">{error}</p>
          )}
          {members?.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-[13px] font-semibold text-white"
                style={{ backgroundColor: colorFor(m.full_name) }}
                aria-hidden
              >
                {initials(m.full_name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`${isWA ? 'text-[15px]' : 'text-sm'} truncate`}>
                  {m.full_name}
                  {m.is_trainer && (
                    <span
                      className={`ml-2 text-[10px] uppercase tracking-wide ${isWA ? 'text-wa-teal' : 'text-accent'}`}
                    >
                      trainer
                    </span>
                  )}
                </div>
                <div
                  className={`${isWA ? 'text-[12px] text-wa-text-secondary' : 'text-xs text-muted'} truncate`}
                >
                  {m.team_name
                    ? `${FUNCTION_ICON[m.function_key ?? m.team_name] ?? ''} ${m.team_name}`.trim()
                    : m.role}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
