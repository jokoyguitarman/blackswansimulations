/**
 * Origin (channel) badge for injects — the same colour code the sim uses for its apps:
 * Fakebook #1877F2 · Z #16181C · Mail · News · Chat · Call.
 *
 * Mapping mirrors the platform pill that used to live in SocialScenarioEditor's InjectCard:
 *   delivery_config.app ?? inject.type  → social_feed (+ platform facebook → Fakebook, else Z),
 *   email → Mail, news → News, group_chat/team_chat → Chat, phone_call → Call.
 */
import { WrIcon, type WrIconName } from './WarRoomIcon';

export type Origin = 'fb' | 'z' | 'mail' | 'news' | 'chat' | 'call' | 'other';

export interface OriginInject {
  type?: string | null;
  delivery_config?: Record<string, unknown> | null;
}

export function originOf(inject: OriginInject): Origin {
  const dc = (inject.delivery_config ?? {}) as Record<string, unknown>;
  const app = String(dc.app ?? inject.type ?? '').toLowerCase();
  if (app === 'social_feed' || app === 'social' || app === 'social_media' || app === 'post') {
    return String(dc.platform ?? 'x_twitter').toLowerCase() === 'facebook' ? 'fb' : 'z';
  }
  if (app === 'email' || app === 'mail') return 'mail';
  if (app === 'news' || app === 'news_article' || app === 'article') return 'news';
  if (app === 'group_chat' || app === 'team_chat' || app === 'chat' || app === 'dm') return 'chat';
  if (app === 'phone_call' || app === 'call' || app === 'voice') return 'call';
  return 'other';
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  fb: 'Fakebook',
  z: 'Z',
  mail: 'Mail',
  news: 'News',
  chat: 'Chat',
  call: 'Call',
  other: 'Other',
};

const ORIGIN_ICON: Record<Origin, WrIconName> = {
  fb: 'feed',
  z: 'feed',
  mail: 'mail',
  news: 'news',
  chat: 'chat',
  call: 'call',
  other: 'layers',
};

export const ORIGINS: Origin[] = ['fb', 'z', 'mail', 'news', 'chat', 'call'];

export const OriginBadge = ({
  inject,
  origin,
  size = 'md',
  label,
  className = '',
}: {
  inject?: OriginInject;
  origin?: Origin;
  size?: 'sm' | 'md';
  /** override the label (e.g. the raw type for `other`) */
  label?: string;
  className?: string;
}) => {
  const o = origin ?? (inject ? originOf(inject) : 'other');
  const text =
    label ??
    (o === 'other' && inject?.type ? String(inject.type).replace(/_/g, ' ') : ORIGIN_LABEL[o]);
  return (
    <span
      className={`wr-ch ${o} ${size === 'sm' ? 'sm' : ''} ${className}`}
      title={ORIGIN_LABEL[o]}
    >
      <WrIcon name={ORIGIN_ICON[o]} size={size === 'sm' ? 10 : 12} />
      {text}
    </span>
  );
};
