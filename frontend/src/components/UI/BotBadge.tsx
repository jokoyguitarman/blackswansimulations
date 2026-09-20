/** Small inline marker for pooled AI teammate accounts (user_profiles.is_bot). */
export function BotBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider align-middle ${className}`}
      style={{
        backgroundColor: 'rgba(30,58,95,0.10)',
        color: '#1E3A5F',
        border: '1px solid rgba(30,58,95,0.25)',
      }}
      title="AI teammate"
    >
      Bot
    </span>
  );
}
