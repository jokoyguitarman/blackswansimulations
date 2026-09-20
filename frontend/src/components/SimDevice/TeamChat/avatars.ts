/** Team-function glyphs (by function_key, contract §5.2) and people avatars. */
export const FUNCTION_ICON: Record<string, string> = {
  Communications: '📣',
  Procurement: '📦',
  Sales: '🤝',
  Legal: '⚖️',
  Executive: '🏛️',
  Investigations: '🔍',
  Operations: '🛠️',
};

export const CHANNEL_TYPE_ICON: Record<string, string> = {
  inter_agency: '🌐',
  command: '🎯',
  public: '📢',
  trainer: '🎓',
  private: '🔒',
  role_specific: '👥',
};

export function groupIcon(functionKey: string | null, channelType: string, name: string): string {
  if (functionKey && FUNCTION_ICON[functionKey]) return FUNCTION_ICON[functionKey];
  if (FUNCTION_ICON[name]) return FUNCTION_ICON[name];
  return CHANNEL_TYPE_ICON[channelType] || '💬';
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const PALETTE = [
  '#00A884',
  '#53BDEB',
  '#FC7B92',
  '#FFB74D',
  '#B39DDB',
  '#7BC862',
  '#F0A35E',
  '#5CA9E9',
];

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
