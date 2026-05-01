import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { getWebSocketService } from './websocketService.js';

export interface DeliveryConfig {
  app: 'social_feed' | 'group_chat' | 'email' | 'news' | 'phone_call';
  platform?: string;
  author_handle?: string;
  author_display_name?: string;
  author_type?: string;
  virality_score?: number;
  content_flags?: Record<string, unknown>;
  engagement_seed?: { likes?: number; reposts?: number; replies?: number };
  spawn_replies?: number;
  reply_sentiment_distribution?: Record<string, number>;
  // Email-specific
  from_address?: string;
  from_name?: string;
  priority?: string;
  // News-specific
  outlet_name?: string;
  headline?: string;
  category?: string;
  // Chat-specific
  sender_name?: string;
  channel_type?: string;
}

export async function routeInjectToApp(
  sessionId: string,
  injectId: string,
  inject: {
    title: string;
    content: string;
    type: string;
    severity: string;
    delivery_config: DeliveryConfig | null;
    requires_response?: boolean;
    trigger_time_minutes?: number | null;
  },
): Promise<void> {
  const config = inject.delivery_config;
  if (!config) return;

  try {
    switch (config.app) {
      case 'social_feed':
        await routeToSocialFeed(sessionId, injectId, inject, config);
        break;
      case 'email':
        await routeToEmail(sessionId, injectId, inject, config);
        break;
      case 'news':
        await routeToNews(sessionId, injectId, inject, config);
        break;
      case 'group_chat':
        await routeToGroupChat(sessionId, injectId, inject, config);
        break;
      case 'phone_call':
        await routeToPhoneCall(sessionId, injectId, inject, config);
        break;
      default:
        logger.warn({ app: config.app, injectId }, 'Unknown delivery_config app');
    }
  } catch (err) {
    logger.error({ err, sessionId, injectId, app: config.app }, 'Feed engine routing failed');
  }
}

async function routeToSocialFeed(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string; severity: string; requires_response?: boolean },
  config: DeliveryConfig,
): Promise<void> {
  const hashtags = inject.content.match(/#\w+/g) || [];
  const seed = config.engagement_seed || {};

  const { data: post, error } = await supabaseAdmin
    .from('social_posts')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      platform: config.platform || 'x_twitter',
      author_handle: config.author_handle || '@system',
      author_display_name: config.author_display_name || 'System',
      author_type: config.author_type || 'npc_public',
      content: inject.content,
      hashtags,
      like_count: seed.likes || 0,
      repost_count: seed.reposts || 0,
      reply_count: seed.replies || 0,
      view_count: Math.floor((seed.likes || 0) * 3.5),
      sentiment: determineSentiment(config.content_flags),
      content_flags: config.content_flags || {},
      virality_score: config.virality_score || 0,
      requires_response: inject.requires_response || false,
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create social post from inject');
    return;
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'social_post.created',
    data: { post },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, postId: post.id }, 'Inject routed to social feed');
}

async function routeToEmail(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string },
  config: DeliveryConfig,
): Promise<void> {
  const lines = inject.content.split('\n');
  const subjectLine = lines.find((l) => l.startsWith('Subject:'));
  const subject = subjectLine ? subjectLine.replace('Subject:', '').trim() : inject.title;
  const bodyText = lines
    .filter((l) => !l.startsWith('Subject:'))
    .join('\n')
    .trim();

  const { data: email, error } = await supabaseAdmin
    .from('sim_emails')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      direction: 'inbound',
      from_address: config.from_address || 'system@sim.local',
      from_name: config.from_name || 'System',
      to_addresses: ['team@harmony.gov.sg'],
      subject,
      body_html: `<p>${bodyText.replace(/\n/g, '</p><p>')}</p>`,
      body_text: bodyText,
      priority: config.priority || 'normal',
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create email from inject');
    return;
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'sim_email.received',
    data: { email },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, emailId: email.id }, 'Inject routed to email');
}

async function routeToNews(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string },
  config: DeliveryConfig,
): Promise<void> {
  const { data: article, error } = await supabaseAdmin
    .from('sim_news_articles')
    .insert({
      session_id: sessionId,
      inject_id: injectId,
      outlet_name: config.outlet_name || 'News Wire',
      headline: config.headline || inject.title,
      body: inject.content,
      category: config.category || 'breaking',
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create news article from inject');
    return;
  }

  getWebSocketService().broadcastToSession(sessionId, {
    type: 'news_article.published',
    data: { article },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId, articleId: article.id }, 'Inject routed to news');
}

async function routeToGroupChat(
  sessionId: string,
  injectId: string,
  inject: { content: string },
  config: DeliveryConfig,
): Promise<void> {
  const channelType = config.channel_type || 'public';
  const { data: channel } = await supabaseAdmin
    .from('chat_channels')
    .select('id')
    .eq('session_id', sessionId)
    .eq('type', channelType)
    .limit(1)
    .single();

  if (!channel) {
    logger.warn({ sessionId, channelType }, 'No channel found for group chat inject');
    return;
  }

  const { data: trainer } = await supabaseAdmin
    .from('sessions')
    .select('trainer_id')
    .eq('id', sessionId)
    .single();

  if (!trainer) return;

  const { data: message, error } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      channel_id: channel.id,
      session_id: sessionId,
      sender_id: trainer.trainer_id,
      content: `[${config.sender_name || 'NPC'}] ${inject.content}`,
      type: 'text',
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, sessionId, injectId }, 'Failed to create chat message from inject');
    return;
  }

  getWebSocketService().messageSent(channel.id, message as Record<string, unknown>);
  logger.info({ sessionId, injectId, messageId: message.id }, 'Inject routed to group chat');
}

async function routeToPhoneCall(
  sessionId: string,
  injectId: string,
  inject: { title: string; content: string },
  config: DeliveryConfig,
): Promise<void> {
  getWebSocketService().broadcastToSession(sessionId, {
    type: 'phone_call.incoming',
    data: {
      inject_id: injectId,
      caller_name: config.from_name || inject.title,
      caller_number: config.from_address || '+65 XXXX XXXX',
      dialogue: inject.content,
    },
    timestamp: new Date().toISOString(),
  });

  logger.info({ sessionId, injectId }, 'Inject routed to phone call');
}

function determineSentiment(flags: Record<string, unknown> | undefined): string {
  if (!flags) return 'neutral';
  if (flags.is_hate_speech || flags.incites_violence) return 'hateful';
  if (flags.is_racist) return 'inflammatory';
  if (flags.is_misinformation) return 'negative';
  return 'neutral';
}
