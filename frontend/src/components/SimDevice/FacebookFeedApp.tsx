import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { supabase } from '../../lib/supabase';
import FacebookMessengerView from './FacebookMessengerView';
import FacebookGroupsView from './FacebookGroupsView';
import FacebookEventsView from './FacebookEventsView';
import OrgPageView from './OrgPageView';
import PlayerActivityPanel from './PlayerActivityPanel';
import ShareMenu from './ShareMenu';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/$/, '')}${cleanPath}`;
  return cleanPath;
}

async function getAuthHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  };
}

type PostFormat =
  | 'text'
  | 'official_statement'
  | 'infographic'
  | 'humor_meme'
  | 'video_concept'
  | 'personal_story';

const POST_FORMATS: Array<{ value: PostFormat; label: string; icon: string }> = [
  { value: 'text', label: 'Post', icon: '✏️' },
  { value: 'official_statement', label: 'Statement', icon: '📋' },
  { value: 'infographic', label: 'Info', icon: '📊' },
  { value: 'humor_meme', label: 'Meme', icon: '😄' },
  { value: 'video_concept', label: 'Video', icon: '🎬' },
  { value: 'personal_story', label: 'Story', icon: '💬' },
];

const FORMAT_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  official_statement: { label: 'Official Statement', bg: '#E3F2FD', fg: '#1565C0' },
  infographic: { label: 'Infographic', bg: '#E8F5E9', fg: '#2E7D32' },
  humor_meme: { label: 'Meme/Humor', bg: '#FCE4EC', fg: '#C62828' },
  video_concept: { label: 'Video', bg: '#EDE7F6', fg: '#4527A0' },
  personal_story: { label: 'Personal Story', bg: '#FFF3E0', fg: '#E65100' },
};

const REACTIONS = [
  { type: 'like', emoji: '👍', bg: '#1877F2' },
  { type: 'love', emoji: '❤️', bg: '#F33E58' },
  { type: 'haha', emoji: '😂', bg: '#F7B928' },
  { type: 'wow', emoji: '😮', bg: '#F7B928' },
  { type: 'angry', emoji: '😡', bg: '#E9710F' },
  { type: 'sad', emoji: '😢', bg: '#F7B928' },
];

interface SocialPost {
  id: string;
  author_handle: string;
  author_display_name: string;
  author_type: string;
  content: string;
  hashtags: string[];
  like_count: number;
  repost_count: number;
  reply_count: number;
  view_count: number;
  sentiment: string;
  content_flags: Record<string, unknown>;
  is_flagged_by_player: boolean;
  requires_response: boolean;
  responded_at: string | null;
  is_repost: boolean;
  original_post_id?: string;
  original_author_handle?: string;
  original_author_display_name?: string;
  created_at: string;
  platform: string;
  virality_score: number;
  reply_to_post_id: string | null;
  liked_by_me?: boolean;
  my_reaction?: string | null;
  flagged_by_me?: boolean;
  post_format?: string;
  media_urls?: string[];
  posted_by_display_name?: string;
  is_branded_history?: boolean;
  target_player_ids?: string[];
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getAvatarColor(name: string): string {
  const colors = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getReactionEmoji(reactionType: string | undefined): string {
  const map: Record<string, string> = {
    like: '👍',
    love: '❤️',
    haha: '😂',
    wow: '😮',
    angry: '😡',
    sad: '😢',
  };
  return map[reactionType || ''] || '👍';
}

export default function FacebookFeedApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isTrainer } = useRoleVisibility();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [postReplies, setPostReplies] = useState<Record<string, SocialPost[]>>({});
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const [postingAsPage, setPostingAsPage] = useState(false);
  const [pageMode, setPageMode] = useState(false);
  const [orgPageInfo, setOrgPageInfo] = useState<{
    page_name: string;
    page_handle: string;
    page_logo_url?: string;
  } | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const [playerDisplayName, setPlayerDisplayName] = useState('Player');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      currentUserIdRef.current = session?.user?.id || null;
      const metaName = session?.user?.user_metadata?.full_name as string | undefined;
      if (metaName) {
        setPlayerDisplayName(metaName);
      } else if (session?.user?.id) {
        supabase
          .from('user_profiles')
          .select('full_name')
          .eq('id', session.user.id)
          .single()
          .then(({ data }) => {
            if (data?.full_name) setPlayerDisplayName(data.full_name);
          });
      }
    });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(apiUrl(`/api/social/org-page/session/${sessionId}`), { headers });
        const json = await res.json();
        const fbPage = (json.data || []).find(
          (p: Record<string, string>) => p.platform === 'facebook',
        );
        if (fbPage)
          setOrgPageInfo({
            page_name: fbPage.page_name,
            page_handle: fbPage.page_handle,
            page_logo_url: fbPage.page_logo_url || '',
          });
      } catch {
        /* non-critical */
      }
    })();
  }, [sessionId]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<PostFormat>('text');
  const [showReactions, setShowReactions] = useState<string | null>(null);
  const [myReactions, setMyReactions] = useState<Record<string, string>>({});
  const [commentText, setCommentText] = useState<Record<string, string>>({});
  const [replyTarget, setReplyTarget] = useState<
    Record<string, { handle: string; displayName: string; replyToId: string } | null>
  >({});
  const [shareMenuPostId, setShareMenuPostId] = useState<string | null>(null);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
  const [mediaPromptText, setMediaPromptText] = useState('');
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaGenerating, setMediaGenerating] = useState(false);
  const [videoDuration, setVideoDuration] = useState(10);
  const [videoOrientation, setVideoOrientation] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [notifCount, setNotifCount] = useState(0);
  const [notifications, setNotifications] = useState<
    Array<{
      id: string;
      type: string;
      title: string;
      message: string;
      read: boolean;
      created_at: string;
      metadata?: Record<string, unknown>;
    }>
  >([]);
  const [activeView, setActiveView] = useState<
    'feed' | 'messenger' | 'groups' | 'events' | 'page' | 'profile'
  >('feed');
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [showMessengerDropdown, setShowMessengerDropdown] = useState(false);
  const [showNewMessageModal, setShowNewMessageModal] = useState(false);
  const [newMsgRecipient, setNewMsgRecipient] = useState<{
    handle: string;
    displayName: string;
  } | null>(null);
  const [newMsgText, setNewMsgText] = useState('');
  const [recipientSearch, setRecipientSearch] = useState('');
  const [openChats, setOpenChats] = useState<
    Array<{ threadId: string; handle: string; displayName: string }>
  >([]);
  const [messengerThreads, setMessengerThreads] = useState<
    Array<{
      thread_id: string;
      other_handle: string;
      other_display_name: string;
      last_message: string;
      last_time: string;
      unread_count: number;
    }>
  >([]);
  const [chatMessages, setChatMessages] = useState<
    Record<
      string,
      Array<{
        id: string;
        sender_handle: string;
        sender_display_name: string;
        content: string;
        created_at: string;
      }>
    >
  >({});
  const [chatInputs, setChatInputs] = useState<Record<string, string>>({});
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [knownHandles, setKnownHandles] = useState<Array<{ handle: string; display_name: string }>>(
    [],
  );
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const reactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDesktopWidth, setIsDesktopWidth] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsDesktopWidth(entry.contentRect.width >= 700);
      }
    });
    observer.observe(el);
    setIsDesktopWidth(el.offsetWidth >= 700);
    return () => observer.disconnect();
  }, []);

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/posts/session/${sessionId}?platform=facebook&limit=1000`),
        {
          headers,
        },
      );
      const result = await res.json();
      if (result.data) {
        const topLevel = (result.data as SocialPost[]).filter((p) => !p.reply_to_post_id);
        const replies = (result.data as SocialPost[])
          .filter((p) => !!p.reply_to_post_id)
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        setPosts(topLevel);
        const replyMap: Record<string, SocialPost[]> = {};
        for (const r of replies) {
          const pid = r.reply_to_post_id!;
          if (!replyMap[pid]) replyMap[pid] = [];
          replyMap[pid].push(r);
        }
        setPostReplies(replyMap);
        // Restore reactions from API data
        const rxMap: Record<string, string> = {};
        for (const p of result.data as SocialPost[]) {
          if (p.my_reaction) rxMap[p.id] = p.my_reaction;
        }
        setMyReactions(rxMap);
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    loadPosts();
    if (sessionId) {
      getAuthHeaders().then((h) =>
        fetch(apiUrl(`/api/social/handles/session/${sessionId}`), { headers: h })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (j?.data) setKnownHandles(j.data);
          })
          .catch(() => {}),
      );
    }
  }, [loadPosts, sessionId]);

  // Re-fetch when navigating back to this view
  useEffect(() => {
    if (location.pathname.includes('/facebook')) loadPosts();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll notification count
  // Poll notification count (Facebook platform only)
  useEffect(() => {
    if (!sessionId) return;
    const fetchCount = async () => {
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(
          apiUrl(`/api/notifications?session_id=${sessionId}&read=false&limit=100`),
          { headers },
        );
        if (res.ok) {
          const json = await res.json();
          const all = json.data || [];
          const socialTypes = ['social_like', 'social_reply', 'social_mention', 'social_repost'];
          const fbCount = all.filter(
            (n: { type: string; metadata?: Record<string, unknown> }) =>
              socialTypes.includes(n.type) && n.metadata?.platform === 'facebook',
          ).length;
          setNotifCount(fbCount);
        }
      } catch {
        /* ignore */
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15000);
    return () => clearInterval(interval);
  }, [sessionId]);

  async function fetchNotifications() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/notifications?session_id=${sessionId}&limit=50`), {
        headers,
      });
      if (res.ok) {
        const json = await res.json();
        const all = json.data || [];
        setNotifications(all);
        const socialTypes = ['social_like', 'social_reply', 'social_mention', 'social_repost'];
        const unreadSocial = all.filter(
          (n: { type: string; read: boolean; metadata?: Record<string, unknown> }) =>
            socialTypes.includes(n.type) && n.metadata?.platform === 'facebook' && !n.read,
        ).length;
        setNotifCount(unreadSocial);
      }
    } catch {
      /* ignore */
    }
  }

  async function loadMessengerThreads() {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/messenger/threads/${sessionId}?platform=facebook`),
        { headers },
      );
      if (res.ok) {
        const json = await res.json();
        const raw = Array.isArray(json.data) ? json.data : [];
        setMessengerThreads(
          raw.map((t: Record<string, unknown>) => ({
            thread_id: String(t.thread_id || ''),
            other_handle: String(
              (t.other_participant as Record<string, string>)?.handle || t.other_handle || '',
            ),
            other_display_name: String(
              (t.other_participant as Record<string, string>)?.display_name ||
                t.other_display_name ||
                '',
            ),
            last_message: String(
              (t.latest_message as Record<string, string>)?.content || t.last_message || '',
            ),
            last_time: String(
              (t.latest_message as Record<string, string>)?.created_at || t.last_time || '',
            ),
            unread_count: Number(t.unread_count) || 0,
          })),
        );
      }
    } catch {
      /* ignore */
    }
  }

  function openChatBox(threadId: string, handle: string, displayName: string) {
    setOpenChats((prev) => {
      if (prev.some((c) => c.threadId === threadId)) return prev;
      const updated = [...prev, { threadId, handle, displayName }];
      return updated.slice(-3);
    });
    loadChatMessages(threadId);
  }

  async function loadChatMessages(threadId: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/messenger/thread/${threadId}`), { headers });
      if (res.ok) {
        const json = await res.json();
        setChatMessages((prev) => ({ ...prev, [threadId]: json.data || [] }));
      }
    } catch {
      /* ignore */
    }
  }

  async function sendChatMessage(threadId: string, recipientHandle: string) {
    const text = chatInputs[threadId]?.trim();
    if (!text || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/messenger/send'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          recipient_handle: recipientHandle,
          content: text,
          platform: 'facebook',
        }),
      });
      setChatInputs((prev) => ({ ...prev, [threadId]: '' }));
      loadChatMessages(threadId);
    } catch {
      /* ignore */
    }
  }

  async function sendNewMessage() {
    if (!newMsgRecipient || !newMsgText.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/messenger/send'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          recipient_handle: newMsgRecipient.handle,
          content: newMsgText.trim(),
          platform: 'facebook',
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const threadId = json.data?.thread_id;
        if (threadId) {
          openChatBox(threadId, newMsgRecipient.handle, newMsgRecipient.displayName);
        }
      }
      setNewMsgText('');
      setNewMsgRecipient(null);
      setRecipientSearch('');
      setShowNewMessageModal(false);
    } catch {
      /* ignore */
    }
  }

  async function markNotifRead(notifId: string) {
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/notifications/${notifId}/read`), { method: 'POST', headers });
      setNotifications((prev) => prev.map((n) => (n.id === notifId ? { ...n, read: true } : n)));
      setNotifCount((c) => Math.max(0, c - 1));
    } catch {
      /* ignore */
    }
  }

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: [
      'social_post.created',
      'social_posts.engagement_update',
      'social_post.media_updated',
      'notification.created',
    ],
    onEvent: (event) => {
      if (event.type === 'social_posts.engagement_update') {
        const updates = (
          event.data as {
            updates: Array<{
              id: string;
              like_count?: number;
              view_count?: number;
              repost_count?: number;
            }>;
          }
        ).updates;
        if (Array.isArray(updates)) {
          setPosts((prev) =>
            prev.map((p) => {
              const up = updates.find((u) => u.id === p.id);
              if (!up) return p;
              return {
                ...p,
                like_count: up.like_count ?? p.like_count,
                view_count: up.view_count ?? p.view_count,
                repost_count: up.repost_count ?? p.repost_count,
              };
            }),
          );
        }
      } else if (event.type === 'social_post.media_updated') {
        const { post_id, media_urls } = event.data as { post_id: string; media_urls: string[] };
        setPosts((prev) => prev.map((p) => (p.id === post_id ? { ...p, media_urls } : p)));
      } else if (event.type === 'social_post.created') {
        const evtData = event.data as { post: SocialPost; target_player_ids?: string[] };
        const targetIds = evtData.target_player_ids;
        if (
          targetIds &&
          Array.isArray(targetIds) &&
          currentUserIdRef.current &&
          !targetIds.includes(currentUserIdRef.current)
        )
          return;
        const newPost = evtData.post;
        if (newPost.platform !== 'facebook') return;
        const isOwnPost =
          currentUserIdRef.current &&
          (newPost as unknown as Record<string, unknown>).user_id === currentUserIdRef.current;
        if (newPost.reply_to_post_id) {
          const pid = newPost.reply_to_post_id!;
          setPostReplies((prev) => {
            const existing = prev[pid] || [];
            if (existing.some((r) => r.id === newPost.id)) return prev;
            return { ...prev, [pid]: [...existing, newPost] };
          });
          if (!isOwnPost) {
            setPosts((prev) =>
              prev.map((p) => (p.id === pid ? { ...p, reply_count: (p.reply_count || 0) + 1 } : p)),
            );
          }
          setExpandedComments((prev) => new Set([...prev, pid]));
        } else {
          if (!isOwnPost) {
            setPosts((prev) => {
              if (prev.some((p) => p.id === newPost.id)) return prev;
              return [newPost, ...prev];
            });
          }
        }
      } else if (event.type === 'notification.created') {
        const eventData = event.data as { user_id?: string } | undefined;
        if (!eventData?.user_id || eventData.user_id === currentUserIdRef.current) {
          setNotifCount((c) => c + 1);
        }
      }
    },
  });

  async function handlePost() {
    if (!composeText.trim() || !sessionId || sending) return;
    setSending(true);
    try {
      const headers = await getAuthHeaders();
      const postRes = await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: composeText,
          platform: 'facebook',
          post_format: selectedFormat,
          image_prompt: mediaPromptText || undefined,
          media_url: mediaPreviewUrl || undefined,
          post_as_page: postingAsPage,
        }),
      });
      if (!postRes.ok) {
        console.error('Post failed:', postRes.status);
        return;
      }
      const result = await postRes.json().catch(() => null);
      const createdPost = result?.data as SocialPost | undefined;
      if (createdPost && !createdPost.reply_to_post_id) {
        setPosts((prev) => {
          if (prev.some((p) => p.id === createdPost.id)) return prev;
          return [createdPost, ...prev];
        });
      }

      setComposeText('');
      setMediaPromptText('');
      setMediaPreviewUrl(null);
      setShowMediaPanel(false);
      setMediaGenerating(false);
      setComposing(false);
      setSelectedFormat('text');
      setPostingAsPage(false);
    } catch {
      /* ignore */
    }
    setSending(false);
  }

  async function handleGeneratePreview() {
    if (!mediaPromptText.trim()) return;
    setMediaGenerating(true);
    setMediaPreviewUrl(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/media/preview'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: mediaPromptText,
          media_type: mediaType,
          duration: mediaType === 'video' ? videoDuration : undefined,
          aspect_ratio: mediaType === 'video' ? videoOrientation : undefined,
        }),
      });
      const json = await res.json();
      if (json.status === 'completed' && json.preview_url) {
        setMediaPreviewUrl(json.preview_url);
        setMediaGenerating(false);
      } else if (json.status === 'generating' && json.preview_id) {
        const previewId = json.preview_id;
        const poll = async () => {
          for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const pollRes = await fetch(apiUrl(`/api/social/media/preview/${previewId}`), {
                headers,
              });
              const pollJson = await pollRes.json();
              if (pollJson.status === 'completed' && pollJson.preview_url) {
                setMediaPreviewUrl(pollJson.preview_url);
                setMediaGenerating(false);
                return;
              }
              if (pollJson.status === 'failed') {
                setMediaGenerating(false);
                return;
              }
            } catch {
              /* continue polling */
            }
          }
          setMediaGenerating(false);
        };
        void poll();
      } else {
        setMediaGenerating(false);
      }
    } catch {
      setMediaGenerating(false);
    }
  }

  async function handleReaction(postId: string, reactionType: string = 'like') {
    const post = posts.find((p) => p.id === postId);
    const alreadyLiked = post?.liked_by_me;
    if (post) {
      if (!alreadyLiked) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId ? { ...p, like_count: p.like_count + 1, liked_by_me: true } : p,
          ),
        );
      }
    } else {
      setPostReplies((prev) => {
        const updated: Record<string, SocialPost[]> = {};
        for (const [pid, replies] of Object.entries(prev)) {
          updated[pid] = replies.map((r) =>
            r.id === postId
              ? {
                  ...r,
                  like_count: (r.like_count || 0) + (r.liked_by_me ? 0 : 1),
                  liked_by_me: true,
                }
              : r,
          );
        }
        return updated;
      });
    }
    setMyReactions((prev) => ({ ...prev, [postId]: reactionType }));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/like`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, reaction_type: reactionType }),
      });
    } catch {
      if (post && !alreadyLiked) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId ? { ...p, like_count: p.like_count - 1, liked_by_me: false } : p,
          ),
        );
      }
    }
    setShowReactions(null);
  }

  function handleShare(postId: string) {
    setShareMenuPostId((prev) => (prev === postId ? null : postId));
  }

  function handleReposted(postId: string, repost: Record<string, unknown>) {
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, repost_count: p.repost_count + 1 } : p)),
    );
    if (repost && repost.id) {
      setPosts((prev) => [repost as unknown as SocialPost, ...prev]);
    }
    setShareMenuPostId(null);
  }

  async function handleComment(postId: string) {
    const text = commentText[postId]?.trim();
    if (!text || !sessionId || sending) return;
    setSending(true);
    const target = replyTarget[postId];
    const contentToSend = target ? `${target.handle}[${target.replyToId}] ${text}` : text;
    try {
      const headers = await getAuthHeaders();
      const postRes = await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: contentToSend,
          reply_to_post_id: postId,
          platform: 'facebook',
          post_as_page: pageMode,
        }),
      });
      if (postRes.ok) {
        const result = await postRes.json().catch(() => null);
        const createdReply = result?.data as SocialPost | undefined;
        if (createdReply) {
          setPostReplies((prev) => {
            const existing = prev[postId] || [];
            if (existing.some((r) => r.id === createdReply.id)) return prev;
            return { ...prev, [postId]: [...existing, createdReply] };
          });
          setPosts((prev) =>
            prev.map((p) =>
              p.id === postId ? { ...p, reply_count: (p.reply_count || 0) + 1 } : p,
            ),
          );
          setExpandedComments((prev) => new Set([...prev, postId]));
        }
      }
      setCommentText((prev) => ({ ...prev, [postId]: '' }));
      setReplyTarget((prev) => ({ ...prev, [postId]: null }));
    } catch {
      /* ignore */
    }
    setSending(false);
  }

  async function handleFlag(postId: string) {
    const post = posts.find((p) => p.id === postId);
    if (post?.flagged_by_me) return;
    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, flagged_by_me: true } : p)));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/flag`), { method: 'POST', headers });
    } catch {
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, flagged_by_me: false } : p)));
    }
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function getBadge(type: string): string | null {
    if (type === 'npc_media' || type === 'official_account') return '✓';
    if (type === 'npc_politician') return '🏛️';
    if (type === 'npc_influencer') return '⭐';
    return null;
  }

  const maxChars = 2000;

  return (
    <div
      ref={containerRef}
      className="h-full flex flex-col relative"
      style={{ backgroundColor: '#F0F2F5', colorScheme: 'light' as const }}
    >
      {/* ── Facebook Desktop Header ── */}
      <div
        style={{ backgroundColor: '#FFFFFF', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}
        className="flex-shrink-0"
      >
        <div className="flex items-center px-3" style={{ height: 56 }}>
          {/* Left: Logo */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {isDesktopWidth ? (
              <span
                className="text-[24px] font-extrabold italic"
                style={{ color: '#1877F2', fontFamily: 'Georgia, serif', letterSpacing: '-0.5px' }}
              >
                fakebook
              </span>
            ) : (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center"
                style={{ backgroundColor: '#1877F2' }}
              >
                <span
                  className="text-[20px] font-extrabold italic text-white"
                  style={{ fontFamily: 'Georgia, serif' }}
                >
                  f
                </span>
              </div>
            )}
          </div>

          {/* Center: Nav Tabs */}
          <div className="flex-1 flex items-center justify-center gap-1">
            {[
              {
                label: 'Home',
                view: 'feed' as const,
                icon: (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill={activeView === 'feed' ? '#1877F2' : 'none'}
                    stroke={activeView === 'feed' ? '#1877F2' : '#65676B'}
                    strokeWidth="2"
                  >
                    <path d="M3 9.5L12 2l9 7.5V22H15v-6H9v6H3V9.5z" />
                  </svg>
                ),
              },
              {
                label: 'Groups',
                view: 'groups' as const,
                icon: (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill={activeView === 'groups' ? '#1877F2' : 'none'}
                    stroke={activeView === 'groups' ? '#1877F2' : '#65676B'}
                    strokeWidth="2"
                  >
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                  </svg>
                ),
              },
              {
                label: 'Events',
                view: 'events' as const,
                icon: (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill={activeView === 'events' ? '#1877F2' : 'none'}
                    stroke={activeView === 'events' ? '#1877F2' : '#65676B'}
                    strokeWidth="2"
                  >
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                ),
              },
            ].map((tab) => (
              <button
                key={tab.label}
                onClick={() => {
                  setActiveView(tab.view);
                  setShowNotifPanel(false);
                  setShowMessengerDropdown(false);
                }}
                className="relative px-3 py-3 rounded-lg hover:bg-[#F0F2F5] transition-colors"
                title={tab.label}
              >
                {tab.icon}
                {activeView === tab.view && (
                  <div
                    className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full"
                    style={{ backgroundColor: '#1877F2' }}
                  />
                )}
              </button>
            ))}
          </div>

          {/* Right: Messenger, Notifications, Profile */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Messenger Icon */}
            <button
              onClick={() => {
                setShowMessengerDropdown(!showMessengerDropdown);
                setShowNotifPanel(false);
                loadMessengerThreads();
              }}
              className="w-9 h-9 rounded-full flex items-center justify-center relative"
              style={{ backgroundColor: showMessengerDropdown ? '#E7F3FF' : '#E4E6EB' }}
              title="Messenger"
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>&#x1F4AC;</span>
            </button>

            {/* Notifications Icon */}
            <button
              onClick={() => {
                setShowNotifPanel(!showNotifPanel);
                setShowMessengerDropdown(false);
                if (!showNotifPanel) fetchNotifications();
              }}
              className="w-9 h-9 rounded-full flex items-center justify-center relative"
              style={{ backgroundColor: showNotifPanel ? '#E7F3FF' : '#E4E6EB' }}
              title="Notifications"
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>&#x1F514;</span>
              {notifCount > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[11px] font-bold text-white"
                  style={{ backgroundColor: '#F02849' }}
                >
                  {notifCount > 99 ? '99+' : notifCount}
                </span>
              )}
            </button>

            {/* Switch to Z */}
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/social`)}
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#000' }}
              title="Switch to Z"
            >
              <span className="text-[14px] font-bold" style={{ color: '#FFFFFF' }}>
                Z
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Messenger Dropdown ── */}
      {showMessengerDropdown && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMessengerDropdown(false)} />
          <div
            className="absolute right-3 top-[58px] z-50 rounded-lg overflow-hidden"
            style={{
              width: 360,
              maxHeight: '70%',
              backgroundColor: '#FFFFFF',
              boxShadow: '0 12px 28px rgba(0,0,0,0.2)',
            }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-[20px] font-bold" style={{ color: '#050505' }}>
                Chats
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setShowNewMessageModal(true);
                    setShowMessengerDropdown(false);
                  }}
                  className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#F0F2F5]"
                  title="New message"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#050505"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    setActiveView('messenger');
                    setShowMessengerDropdown(false);
                  }}
                  className="text-[13px] font-semibold px-3 py-1 rounded-md hover:bg-[#F0F2F5]"
                  style={{ color: '#1877F2' }}
                >
                  See all
                </button>
              </div>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: 400 }}>
              {messengerThreads.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-[14px]" style={{ color: '#65676B' }}>
                    No messages yet
                  </span>
                </div>
              ) : (
                messengerThreads.map((thread) => (
                  <button
                    key={thread.thread_id}
                    onClick={() => {
                      openChatBox(thread.thread_id, thread.other_handle, thread.other_display_name);
                      setShowMessengerDropdown(false);
                    }}
                    className="flex items-center gap-3 w-full text-left px-4 py-2.5 hover:bg-[#F0F2F5] transition-colors"
                  >
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(thread.other_display_name) }}
                    >
                      {thread.other_display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span
                        className={`text-[15px] block truncate ${thread.unread_count > 0 ? 'font-bold' : ''}`}
                        style={{ color: '#050505' }}
                      >
                        {thread.other_display_name}
                      </span>
                      <span
                        className={`text-[13px] block truncate ${thread.unread_count > 0 ? 'font-semibold' : ''}`}
                        style={{ color: thread.unread_count > 0 ? '#050505' : '#65676B' }}
                      >
                        {thread.last_message?.substring(0, 40) || 'Start a conversation'}
                      </span>
                    </div>
                    {thread.unread_count > 0 && (
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: '#1877F2' }}
                      />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {/* New Message Modal */}
      {showNewMessageModal && (
        <>
          <div
            className="fixed inset-0 z-50"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
            onClick={() => setShowNewMessageModal(false)}
          />
          <div
            className="absolute inset-x-0 top-[60px] mx-auto z-50 rounded-lg overflow-hidden"
            style={{
              width: 400,
              maxHeight: '80%',
              backgroundColor: '#FFFFFF',
              boxShadow: '0 12px 28px rgba(0,0,0,0.3)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid #E4E6EB' }}
            >
              <span className="text-[17px] font-bold" style={{ color: '#050505' }}>
                New Message
              </span>
              <button
                onClick={() => {
                  setShowNewMessageModal(false);
                  setNewMsgRecipient(null);
                  setRecipientSearch('');
                }}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#F0F2F5]"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {!newMsgRecipient ? (
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[14px] font-semibold" style={{ color: '#050505' }}>
                    To:
                  </span>
                  <input
                    type="text"
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    placeholder="Search for a person..."
                    className="flex-1 px-3 py-1.5 rounded-full text-[14px] outline-none"
                    style={{ backgroundColor: '#F0F2F5', color: '#050505' }}
                    autoFocus
                  />
                </div>
                <div className="max-h-[250px] overflow-y-auto">
                  {knownHandles
                    .filter(
                      (h) =>
                        h.display_name.toLowerCase().includes(recipientSearch.toLowerCase()) ||
                        h.handle.toLowerCase().includes(recipientSearch.toLowerCase()),
                    )
                    .slice(0, 10)
                    .map((h) => (
                      <button
                        key={h.handle}
                        onClick={() =>
                          setNewMsgRecipient({ handle: h.handle, displayName: h.display_name })
                        }
                        className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-[#F0F2F5] transition-colors"
                      >
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[14px]"
                          style={{ backgroundColor: getAvatarColor(h.display_name) }}
                        >
                          {h.display_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <span
                            className="text-[14px] font-semibold block"
                            style={{ color: '#050505' }}
                          >
                            {h.display_name}
                          </span>
                          <span className="text-[12px]" style={{ color: '#65676B' }}>
                            {h.handle}
                          </span>
                        </div>
                      </button>
                    ))}
                  {knownHandles.filter((h) =>
                    h.display_name.toLowerCase().includes(recipientSearch.toLowerCase()),
                  ).length === 0 && (
                    <p className="text-[13px] text-center py-4" style={{ color: '#65676B' }}>
                      No contacts found
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col" style={{ height: 300 }}>
                <div
                  className="px-4 py-2 flex items-center gap-2"
                  style={{ borderBottom: '1px solid #E4E6EB' }}
                >
                  <span className="text-[14px]" style={{ color: '#65676B' }}>
                    To:
                  </span>
                  <span
                    className="text-[14px] font-semibold px-2 py-0.5 rounded-md"
                    style={{ backgroundColor: '#E7F3FF', color: '#1877F2' }}
                  >
                    {newMsgRecipient.displayName}
                  </span>
                  <button
                    onClick={() => setNewMsgRecipient(null)}
                    className="text-[12px]"
                    style={{ color: '#65676B' }}
                  >
                    Change
                  </button>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-[13px]" style={{ color: '#65676B' }}>
                    Start a conversation with {newMsgRecipient.displayName}
                  </p>
                </div>
                <div
                  className="flex items-center gap-2 px-4 py-3"
                  style={{ borderTop: '1px solid #E4E6EB' }}
                >
                  <input
                    type="text"
                    value={newMsgText}
                    onChange={(e) => setNewMsgText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') sendNewMessage();
                    }}
                    placeholder="Type a message..."
                    className="flex-1 px-3 py-2 rounded-full text-[14px] outline-none"
                    style={{ backgroundColor: '#F0F2F5', color: '#050505' }}
                    autoFocus
                  />
                  <button
                    onClick={sendNewMessage}
                    disabled={!newMsgText.trim()}
                    className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-30"
                    style={{ color: '#1877F2' }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#1877F2">
                      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Notification Panel Overlay */}
      {showNotifPanel && (
        <>
          <div
            className="absolute inset-0"
            style={{ zIndex: 40 }}
            onClick={() => setShowNotifPanel(false)}
          />
          <div
            className="absolute left-0 right-0 overflow-y-auto"
            style={{
              top: 96,
              zIndex: 45,
              maxHeight: '65%',
              backgroundColor: '#FFFFFF',
              borderBottom: '2px solid #DADDE1',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: '1px solid #DADDE1' }}
            >
              <span className="text-[17px] font-bold" style={{ color: '#050505' }}>
                Notifications
              </span>
              {notifCount > 0 && (
                <button
                  onClick={async () => {
                    try {
                      const headers = await getAuthHeaders();
                      await fetch(apiUrl(`/api/notifications/read-all`), {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ session_id: sessionId }),
                      });
                      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                      setNotifCount(0);
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="text-[14px] font-semibold"
                  style={{ color: '#1877F2' }}
                >
                  Mark all read
                </button>
              )}
            </div>
            {(() => {
              const socialTypes = [
                'social_like',
                'social_reply',
                'social_mention',
                'social_repost',
              ];
              const fbNotifs = notifications.filter(
                (n) => socialTypes.includes(n.type) && n.metadata?.platform === 'facebook',
              );
              return fbNotifs.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-[14px]" style={{ color: '#65676B' }}>
                    No notifications yet
                  </span>
                </div>
              ) : (
                fbNotifs.map((notif) => (
                  <button
                    key={notif.id}
                    onClick={() => {
                      if (!notif.read) markNotifRead(notif.id);
                      setShowNotifPanel(false);
                      setActiveView('feed');
                      const postId = notif.metadata?.post_id as string | undefined;
                      const highlightId = notif.metadata?.highlight_post_id as string | undefined;
                      if (postId) {
                        setExpandedComments((prev) => new Set([...prev, postId]));
                        setTimeout(() => {
                          const targetEl = highlightId
                            ? document.getElementById(`fb-reply-${highlightId}`)
                            : document.getElementById(`fb-post-${postId}`);
                          if (targetEl) {
                            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            if (highlightId) {
                              targetEl.style.transition = 'background-color 0.3s';
                              targetEl.style.backgroundColor = 'rgba(24,119,242,0.12)';
                              setTimeout(() => {
                                targetEl.style.backgroundColor = '';
                              }, 2500);
                            }
                          } else {
                            document
                              .getElementById(`fb-post-${postId}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }
                        }, 500);
                      }
                    }}
                    className="flex items-start gap-3 w-full text-left px-4 py-3 hover:bg-[#F2F3F5] transition-colors"
                    style={{
                      borderBottom: '1px solid #F0F2F5',
                      backgroundColor: notif.read ? '#FFFFFF' : '#E7F3FF',
                    }}
                  >
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: '#E4E6EB' }}
                    >
                      {notif.type === 'social_like' ? (
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="#F02849"
                          stroke="none"
                        >
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                      ) : notif.type === 'social_reply' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
                            stroke="#1877F2"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : notif.type === 'social_mention' ? (
                        <span className="text-[16px] font-bold" style={{ color: '#1877F2' }}>
                          @
                        </span>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"
                            stroke="#45BD62"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px]" style={{ color: '#050505' }}>
                        {notif.title}
                      </p>
                      {notif.message && (
                        <p className="text-[13px] mt-0.5 truncate" style={{ color: '#65676B' }}>
                          {notif.message}
                        </p>
                      )}
                      <span
                        className="text-[12px] mt-0.5 block"
                        style={{ color: notif.read ? '#65676B' : '#1877F2' }}
                      >
                        {timeAgo(notif.created_at)}
                      </span>
                    </div>
                    {!notif.read && (
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-2"
                        style={{ backgroundColor: '#1877F2' }}
                      />
                    )}
                  </button>
                ))
              );
            })()}
          </div>
        </>
      )}

      {/* Sub-views */}
      {activeView === 'messenger' && sessionId && <FacebookMessengerView sessionId={sessionId} />}
      {activeView === 'groups' && sessionId && <FacebookGroupsView sessionId={sessionId} />}
      {activeView === 'events' && sessionId && <FacebookEventsView sessionId={sessionId} />}
      {activeView === 'page' && sessionId && (
        <OrgPageView platform="facebook" onBack={() => setActiveView('feed')} />
      )}
      {activeView === 'profile' && <PlayerActivityPanel onBack={() => setActiveView('feed')} />}

      {/* Feed View with Sidebar */}
      {activeView === 'feed' && (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar */}
          {isDesktopWidth && (
            <div
              className="flex flex-col flex-shrink-0 overflow-y-auto py-3 px-2"
              style={{ width: 220, backgroundColor: '#F0F2F5' }}
            >
              {[
                {
                  label: 'News Feed',
                  icon: (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#1877F2">
                      <path d="M3 9.5L12 2l9 7.5V22H15v-6H9v6H3V9.5z" />
                    </svg>
                  ),
                  onClick: () => {},
                },
                ...(orgPageInfo
                  ? [
                      {
                        label: pageMode ? `✓ ${orgPageInfo.page_name}` : orgPageInfo.page_name,
                        icon: orgPageInfo.page_logo_url ? (
                          <img
                            src={orgPageInfo.page_logo_url}
                            alt={orgPageInfo.page_name}
                            className="w-5 h-5 rounded object-cover"
                          />
                        ) : (
                          <div
                            className="w-5 h-5 rounded flex items-center justify-center text-white text-[10px] font-bold"
                            style={{ backgroundColor: '#1877F2' }}
                          >
                            {orgPageInfo.page_name[0]}
                          </div>
                        ),
                        onClick: () => {
                          setPageMode((prev) => {
                            const next = !prev;
                            setPostingAsPage(next);
                            return next;
                          });
                          setActiveView('feed');
                        },
                      },
                    ]
                  : []),
                {
                  label: 'Groups',
                  icon: (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#65676B"
                      strokeWidth="2"
                    >
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 00-3-3.87" />
                    </svg>
                  ),
                  onClick: () => {
                    setActiveView('groups');
                  },
                },
                {
                  label: 'Events',
                  icon: (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#65676B"
                      strokeWidth="2"
                    >
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                  ),
                  onClick: () => {
                    setActiveView('events');
                  },
                },
                {
                  label: 'Messenger',
                  icon: (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#65676B"
                      strokeWidth="2"
                    >
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                    </svg>
                  ),
                  onClick: () => {
                    setActiveView('messenger');
                  },
                },
                {
                  label: 'My Activity',
                  icon: (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#65676B"
                      strokeWidth="2"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  ),
                  onClick: () => {
                    setActiveView('profile');
                  },
                },
                {
                  label: 'News',
                  icon: (
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#65676B"
                      strokeWidth="2"
                    >
                      <path d="M4 4h16v16H4z" />
                      <line x1="4" y1="10" x2="20" y2="10" />
                      <line x1="10" y1="4" x2="10" y2="10" />
                    </svg>
                  ),
                  onClick: () => navigate(`/sim/${sessionId}/device/news`),
                },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.onClick}
                  className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-[#E4E6EB] transition-colors"
                >
                  {item.icon}
                  <span className="text-[14px] font-medium" style={{ color: '#050505' }}>
                    {item.label}
                  </span>
                </button>
              ))}

              {/* Your Groups */}
              <div className="mt-4 px-3">
                <span className="text-[13px] font-semibold" style={{ color: '#65676B' }}>
                  Your Groups
                </span>
              </div>
              {(posts.length > 0
                ? Array.from(
                    new Set(
                      posts.flatMap((p) => {
                        const groups: string[] = [];
                        if (p.author_type !== 'player') groups.push(p.author_display_name);
                        return groups;
                      }),
                    ),
                  ).slice(0, 5)
                : []
              ).map((name) => (
                <button
                  key={name}
                  onClick={() => setActiveView('groups')}
                  className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg hover:bg-[#E4E6EB] transition-colors"
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-[11px] font-bold"
                    style={{ backgroundColor: getAvatarColor(name) }}
                  >
                    {name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-[13px] truncate" style={{ color: '#050505' }}>
                    {name}
                  </span>
                </button>
              ))}

              {/* Shortcuts */}
              <div className="mt-4 px-3">
                <span className="text-[13px] font-semibold" style={{ color: '#65676B' }}>
                  Shortcuts
                </span>
              </div>
              <button
                onClick={() => navigate(`/sim/${sessionId}/device/email`)}
                className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-[#E4E6EB] transition-colors"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                >
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <span className="text-[14px] font-medium" style={{ color: '#050505' }}>
                  Email
                </span>
              </button>
              <button
                onClick={() => navigate(`/sim/${sessionId}/device/drafts`)}
                className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg hover:bg-[#E4E6EB] transition-colors"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#65676B"
                  strokeWidth="2"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span className="text-[14px] font-medium" style={{ color: '#050505' }}>
                  Draft Pad
                </span>
              </button>
            </div>
          )}

          {/* Main Feed Column */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Search Bar */}
            <div
              className="flex-shrink-0 px-3 py-2 relative"
              style={{ backgroundColor: '#FFFFFF', borderBottom: '1px solid #DADDE1', zIndex: 30 }}
            >
              <div
                className="flex items-center rounded-full px-3 py-1.5"
                style={{ backgroundColor: '#F0F2F5' }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ flexShrink: 0 }}
                >
                  <circle cx="11" cy="11" r="8" stroke="#65676B" strokeWidth="2" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#65676B" strokeWidth="2" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search posts, #hashtags, @users..."
                  className="flex-1 bg-transparent outline-none text-[13px] ml-2"
                  style={{ color: '#050505' }}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="text-[14px] ml-1"
                    style={{ color: '#65676B' }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {/* Search suggestions */}
              {searchQuery.length >= 1 &&
                (() => {
                  const q = searchQuery.toLowerCase();
                  const allTags = [
                    ...new Set(
                      posts.flatMap((p) => (p.hashtags || []).map((t: string) => t.toLowerCase())),
                    ),
                  ];
                  const allHandles = [...new Set(posts.map((p) => p.author_handle))];
                  const allNames = [...new Set(posts.map((p) => p.author_display_name))];
                  const tagMatches = allTags.filter((t) => t.includes(q)).slice(0, 4);
                  const handleMatches = allHandles
                    .filter((h) => h.toLowerCase().includes(q))
                    .slice(0, 3);
                  const nameMatches = allNames
                    .filter(
                      (n) =>
                        n.toLowerCase().includes(q) &&
                        !handleMatches.some((h) =>
                          posts.some((p) => p.author_handle === h && p.author_display_name === n),
                        ),
                    )
                    .slice(0, 3);
                  const suggestions = [
                    ...tagMatches.map((t) => ({ type: 'hashtag' as const, value: t })),
                    ...handleMatches.map((h) => ({
                      type: 'user' as const,
                      value: h,
                      name: posts.find((p) => p.author_handle === h)?.author_display_name,
                    })),
                    ...nameMatches.map((n) => ({ type: 'name' as const, value: n })),
                  ];
                  if (suggestions.length === 0) return null;
                  return (
                    <div
                      className="absolute left-3 right-3 top-full mt-1 rounded-lg overflow-hidden z-50"
                      style={{
                        backgroundColor: '#FFFFFF',
                        boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
                        border: '1px solid #DADDE1',
                        maxHeight: 200,
                        overflowY: 'auto',
                      }}
                    >
                      {suggestions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => setSearchQuery(s.value)}
                          className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-[#F2F3F5] transition-colors"
                        >
                          {s.type === 'hashtag' ? (
                            <span className="text-[13px] font-bold" style={{ color: '#1877F2' }}>
                              #
                            </span>
                          ) : (
                            <span className="text-[13px] font-bold" style={{ color: '#1877F2' }}>
                              @
                            </span>
                          )}
                          <span className="text-[13px]" style={{ color: '#050505' }}>
                            {s.value}
                          </span>
                          {s.type === 'user' && s.name && (
                            <span className="text-[12px] ml-1" style={{ color: '#65676B' }}>
                              {s.name}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })()}
            </div>

            {/* ── Create Post Bar ── */}
            <div
              className="mx-0 mt-2 px-3 py-2.5"
              style={{
                backgroundColor: '#FFFFFF',
                borderBottom: '1px solid #CED0D4',
                borderTop: '1px solid #CED0D4',
              }}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
                  style={{ backgroundColor: '#1877F2' }}
                >
                  {playerDisplayName.charAt(0).toUpperCase()}
                </div>
                <button
                  onClick={() => setComposing(true)}
                  className="flex-1 text-left px-3.5 py-2 rounded-full text-[15px]"
                  style={{ backgroundColor: '#F0F2F5', color: '#65676B' }}
                >
                  What&apos;s on your mind?
                </button>
                <button onClick={() => setComposing(true)} className="px-2">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <rect
                      x="3"
                      y="3"
                      width="18"
                      height="18"
                      rx="3"
                      stroke="#45BD62"
                      strokeWidth="2"
                    />
                    <circle cx="8.5" cy="8.5" r="1.5" fill="#45BD62" />
                    <path
                      d="M21 15l-5-5L5 21"
                      stroke="#45BD62"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Page Mode Banner */}
            {pageMode && orgPageInfo && (
              <div
                className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5"
                style={{ backgroundColor: '#E7F3FF', borderBottom: '1px solid #C2DBFE' }}
              >
                {orgPageInfo.page_logo_url ? (
                  <img
                    src={orgPageInfo.page_logo_url}
                    alt={orgPageInfo.page_name}
                    className="w-6 h-6 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                    style={{ backgroundColor: '#1877F2' }}
                  >
                    {orgPageInfo.page_name[0]}
                  </div>
                )}
                <span
                  className="text-[12px] font-semibold flex-1 truncate"
                  style={{ color: '#1877F2' }}
                >
                  {isDesktopWidth ? `Managing as ${orgPageInfo.page_name}` : orgPageInfo.page_name}
                </span>
                <button
                  onClick={() => setActiveView('page')}
                  className="text-[11px] font-semibold px-1.5 py-0.5 rounded hover:bg-[#C2DBFE] transition-colors flex-shrink-0"
                  style={{ color: '#1877F2' }}
                >
                  {isDesktopWidth ? 'View Page' : 'Page'}
                </button>
                <button
                  onClick={() => {
                    setPageMode(false);
                    setPostingAsPage(false);
                  }}
                  className="text-[11px] font-semibold px-1.5 py-0.5 rounded hover:bg-[#C2DBFE] transition-colors flex-shrink-0"
                  style={{ color: '#65676B' }}
                >
                  {isDesktopWidth ? 'Switch to Personal' : 'Exit'}
                </button>
              </div>
            )}

            {/* ── Feed ── */}
            <div className="flex-1 overflow-y-auto">
              <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
                {loading ? (
                  <div className="flex items-center justify-center h-32">
                    <div
                      className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin"
                      style={{ borderColor: '#1877F2', borderTopColor: 'transparent' }}
                    />
                  </div>
                ) : posts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 gap-2 px-8 text-center">
                    <p className="text-[16px] font-bold" style={{ color: '#050505' }}>
                      No posts yet
                    </p>
                    <p className="text-[14px]" style={{ color: '#65676B' }}>
                      Posts will appear here as the simulation progresses.
                    </p>
                  </div>
                ) : (
                  posts
                    .filter((p) => {
                      if (p.reply_to_post_id) return false;
                      const q = searchQuery.toLowerCase().trim();
                      if (!q) return true;
                      const content = (p.content || '').toLowerCase();
                      const handle = (p.author_handle || '').toLowerCase();
                      const name = (p.author_display_name || '').toLowerCase();
                      const tags = (p.hashtags || []).map((t: string) => t.toLowerCase());
                      return (
                        content.includes(q) ||
                        handle.includes(q) ||
                        name.includes(q) ||
                        tags.some((t: string) => t.includes(q))
                      );
                    })
                    .sort((a, b) => {
                      const aIsPlayer = a.author_type === 'player';
                      const bIsPlayer = b.author_type === 'player';
                      if (aIsPlayer && !bIsPlayer) return -1;
                      if (!aIsPlayer && bIsPlayer) return 1;
                      if (aIsPlayer && bIsPlayer) {
                        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                      }
                      return (b.virality_score || 0) - (a.virality_score || 0);
                    })
                    .map((post) => {
                      const badge = getBadge(post.author_type);
                      const postReactionEmoji =
                        post.like_count > 0 ? getReactionEmoji(myReactions[post.id]) : '';
                      const replies = postReplies[post.id] || [];
                      const isExpanded = expandedPosts.has(post.id);
                      const isLong = post.content.length > 200;

                      return (
                        <div
                          key={post.id}
                          id={`fb-post-${post.id}`}
                          className="mt-2"
                          style={{
                            backgroundColor: '#FFFFFF',
                            borderTop: '1px solid #CED0D4',
                            borderBottom: '1px solid #CED0D4',
                          }}
                        >
                          {post.is_repost && (
                            <div
                              className="flex items-center gap-1.5 px-3 pt-2 pb-0.5"
                              style={{ color: '#65676B', fontSize: 13 }}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M17 1l4 4-4 4" />
                                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                                <path d="M7 23l-4-4 4-4" />
                                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                              </svg>
                              <span className="font-semibold">{post.author_display_name}</span>
                              <span>shared a post</span>
                            </div>
                          )}

                          {/* Author Row */}
                          <div
                            className="flex items-center gap-2.5 px-3 pt-3 pb-1.5"
                            onClick={
                              post.author_type === 'official_account'
                                ? () => setActiveView('page')
                                : undefined
                            }
                            style={
                              post.author_type === 'official_account'
                                ? { cursor: 'pointer' }
                                : undefined
                            }
                          >
                            {post.author_type === 'official_account' &&
                            orgPageInfo?.page_logo_url ? (
                              <img
                                src={orgPageInfo.page_logo_url}
                                alt={post.author_display_name}
                                className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                              />
                            ) : (
                              <div
                                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
                                style={{
                                  backgroundColor:
                                    post.author_type === 'official_account'
                                      ? '#1877F2'
                                      : getAvatarColor(post.author_display_name),
                                }}
                              >
                                {post.author_display_name.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1">
                                <span
                                  className="font-semibold text-[15px]"
                                  style={{ color: '#050505' }}
                                >
                                  {post.author_display_name}
                                </span>
                                {badge && (
                                  <span className="text-[13px]" style={{ color: '#1877F2' }}>
                                    {badge}
                                  </span>
                                )}
                              </div>
                              {post.author_type === 'official_account' &&
                                post.posted_by_display_name && (
                                  <div className="text-[11px]" style={{ color: '#65676B' }}>
                                    Posted by {post.posted_by_display_name}
                                  </div>
                                )}
                              <div
                                className="flex items-center gap-1 text-[13px]"
                                style={{ color: '#65676B' }}
                              >
                                <span>{timeAgo(post.created_at)}</span>
                                <span>·</span>
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="#65676B">
                                  <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14.5a6.5 6.5 0 110-13 6.5 6.5 0 010 13z" />
                                </svg>
                              </div>
                            </div>
                            <button
                              onClick={() => handleFlag(post.id)}
                              className="p-1.5 rounded-full hover:bg-[#F2F3F5]"
                            >
                              <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill={post.flagged_by_me ? '#F59E0B' : '#65676B'}
                              >
                                <circle cx="12" cy="5" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="12" cy="19" r="2" />
                              </svg>
                            </button>
                          </div>

                          {/* Content Flags (trainer only) */}
                          {isTrainer &&
                            !!(
                              post.content_flags?.is_hate_speech ||
                              post.content_flags?.is_harmful_narrative ||
                              post.content_flags?.is_misinformation ||
                              post.content_flags?.is_inflammatory ||
                              post.content_flags?.incites_violence ||
                              post.content_flags?.is_organized_pressure ||
                              post.content_flags?.is_racist
                            ) && (
                              <div className="px-3 pb-1 flex gap-1.5 flex-wrap">
                                {!!post.content_flags.is_hate_speech && (
                                  <span
                                    className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                    style={{ backgroundColor: '#FDECEA', color: '#D32F2F' }}
                                  >
                                    Hate Speech
                                  </span>
                                )}
                                {!!post.content_flags.is_harmful_narrative &&
                                  !post.content_flags.is_hate_speech && (
                                    <span
                                      className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                      style={{ backgroundColor: '#FDECEA', color: '#D32F2F' }}
                                    >
                                      Harmful
                                    </span>
                                  )}
                                {!!post.content_flags.is_misinformation && (
                                  <span
                                    className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                    style={{ backgroundColor: '#FFF3E0', color: '#E65100' }}
                                  >
                                    Misinformation
                                  </span>
                                )}
                                {!!post.content_flags.is_inflammatory && (
                                  <span
                                    className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                    style={{ backgroundColor: '#FFF3E0', color: '#E65100' }}
                                  >
                                    Inflammatory
                                  </span>
                                )}
                                {!!post.content_flags.incites_violence && (
                                  <span
                                    className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                    style={{ backgroundColor: '#FDECEA', color: '#D32F2F' }}
                                  >
                                    Threat
                                  </span>
                                )}
                                {!!post.content_flags.is_organized_pressure && (
                                  <span
                                    className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                    style={{ backgroundColor: '#FFF3E0', color: '#E65100' }}
                                  >
                                    Pressure
                                  </span>
                                )}
                              </div>
                            )}

                          {isTrainer && post.requires_response && !post.responded_at && (
                            <div className="px-3 pb-1">
                              <span
                                className="text-[11px] font-bold px-2 py-0.5 rounded"
                                style={{ backgroundColor: '#FFF3CD', color: '#856404' }}
                              >
                                REQUIRES RESPONSE
                              </span>
                            </div>
                          )}

                          {post.post_format && FORMAT_BADGE[post.post_format] && (
                            <div className="px-3 pb-1">
                              <span
                                className="text-[11px] px-2 py-0.5 rounded font-semibold"
                                style={{
                                  backgroundColor: FORMAT_BADGE[post.post_format].bg,
                                  color: FORMAT_BADGE[post.post_format].fg,
                                }}
                              >
                                {FORMAT_BADGE[post.post_format].label}
                              </span>
                            </div>
                          )}

                          {/* Content Text */}
                          <div className="px-3 pb-2">
                            <p
                              className="text-[15px] leading-[20px] whitespace-pre-wrap"
                              style={{ color: '#050505' }}
                            >
                              {(() => {
                                const text =
                                  isLong && !isExpanded
                                    ? post.content.substring(0, 200) + '...'
                                    : post.content;
                                const rendered = String(text)
                                  .split(/(#\w+)/g)
                                  .map((part: string, i: number) =>
                                    part.startsWith('#') ? (
                                      <span
                                        key={i}
                                        onClick={() => setSearchQuery(part)}
                                        className="cursor-pointer hover:underline"
                                        style={{ color: '#1877F2' }}
                                      >
                                        {part}
                                      </span>
                                    ) : (
                                      <span key={i}>{part}</span>
                                    ),
                                  );
                                return isLong && !isExpanded ? (
                                  <>
                                    {rendered}
                                    <button
                                      onClick={() =>
                                        setExpandedPosts((prev) => new Set([...prev, post.id]))
                                      }
                                      className="font-semibold ml-1"
                                      style={{ color: '#65676B' }}
                                    >
                                      See more
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    {rendered}
                                    {isLong && (
                                      <button
                                        onClick={() =>
                                          setExpandedPosts((prev) => {
                                            const n = new Set(prev);
                                            n.delete(post.id);
                                            return n;
                                          })
                                        }
                                        className="font-semibold ml-1"
                                        style={{ color: '#65676B' }}
                                      >
                                        See less
                                      </button>
                                    )}
                                  </>
                                );
                              })()}
                            </p>
                          </div>

                          {/* Media */}
                          {Array.isArray(post.media_urls) && post.media_urls.length > 0 && (
                            <div
                              className="relative"
                              style={{ maxHeight: 500, overflow: 'hidden' }}
                            >
                              {/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0]) ? (
                                <video
                                  src={post.media_urls[0]}
                                  controls
                                  className="w-full"
                                  style={{
                                    backgroundColor: '#000',
                                    maxHeight: 500,
                                    objectFit: 'contain',
                                  }}
                                />
                              ) : (
                                <img
                                  src={post.media_urls[0]}
                                  alt=""
                                  className="w-full"
                                  style={{ maxHeight: 500, objectFit: 'cover' }}
                                />
                              )}
                              {post.post_format === 'video_concept' &&
                                !/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0] || '') && (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div
                                      className="w-16 h-16 rounded-full flex items-center justify-center"
                                      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
                                    >
                                      <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                                        <polygon points="8,5 19,12 8,19" />
                                      </svg>
                                    </div>
                                  </div>
                                )}
                            </div>
                          )}

                          {/* Reaction + Comment Counts */}
                          <div
                            className="flex items-center justify-between px-3 py-2"
                            style={{ borderBottom: '1px solid #CED0D4' }}
                          >
                            <div className="flex items-center gap-1">
                              {postReactionEmoji && (
                                <span className="text-[14px]">{postReactionEmoji}</span>
                              )}
                              {post.like_count > 0 && (
                                <span className="text-[14px] ml-1" style={{ color: '#65676B' }}>
                                  {formatCount(post.like_count)}
                                </span>
                              )}
                            </div>
                            <div
                              className="flex items-center gap-3 text-[14px]"
                              style={{ color: '#65676B' }}
                            >
                              {post.reply_count > 0 && (
                                <button
                                  onClick={() =>
                                    setExpandedComments((prev) => new Set([...prev, post.id]))
                                  }
                                  className="hover:underline"
                                  style={{ color: '#65676B' }}
                                >
                                  {formatCount(post.reply_count)} comments
                                </button>
                              )}
                              {post.repost_count > 0 && (
                                <span>{formatCount(post.repost_count)} shares</span>
                              )}
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div
                            className="flex items-center justify-around px-1 py-0.5"
                            style={{
                              borderBottom: '1px solid #CED0D4',
                              backgroundColor: '#FFFFFF',
                            }}
                          >
                            <div className="relative flex-1">
                              {(() => {
                                const myRx = myReactions[post.id];
                                const rxInfo = myRx ? REACTIONS.find((r) => r.type === myRx) : null;
                                const rxColor =
                                  myRx === 'like'
                                    ? '#1877F2'
                                    : myRx === 'love'
                                      ? '#F33E58'
                                      : myRx === 'angry'
                                        ? '#E9710F'
                                        : myRx
                                          ? '#F7B928'
                                          : '#65676B';
                                return (
                                  <button
                                    onClick={() => handleReaction(post.id, 'like')}
                                    onMouseEnter={() => {
                                      if (reactionTimeoutRef.current)
                                        clearTimeout(reactionTimeoutRef.current);
                                      setShowReactions(post.id);
                                    }}
                                    onMouseLeave={() => {
                                      reactionTimeoutRef.current = setTimeout(
                                        () => setShowReactions(null),
                                        600,
                                      );
                                    }}
                                    className="flex items-center justify-center gap-1.5 w-full py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                                    style={{ color: post.liked_by_me ? rxColor : '#65676B' }}
                                  >
                                    {rxInfo ? (
                                      <span className="text-[18px] leading-none">
                                        {rxInfo.emoji}
                                      </span>
                                    ) : (
                                      <svg
                                        width="18"
                                        height="18"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                      >
                                        <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                                      </svg>
                                    )}
                                    <span className="text-[14px] font-semibold">
                                      {rxInfo
                                        ? rxInfo.type.charAt(0).toUpperCase() + rxInfo.type.slice(1)
                                        : 'Like'}
                                    </span>
                                  </button>
                                );
                              })()}
                              {showReactions === post.id && (
                                <div
                                  className="absolute bottom-full left-0 mb-1 flex gap-1 px-2.5 py-2 rounded-full z-50"
                                  style={{
                                    backgroundColor: '#FFFFFF',
                                    boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
                                  }}
                                  onMouseEnter={() => {
                                    if (reactionTimeoutRef.current)
                                      clearTimeout(reactionTimeoutRef.current);
                                    setShowReactions(post.id);
                                  }}
                                  onMouseLeave={() => {
                                    reactionTimeoutRef.current = setTimeout(
                                      () => setShowReactions(null),
                                      300,
                                    );
                                  }}
                                >
                                  {REACTIONS.map((r) => (
                                    <button
                                      key={r.type}
                                      onClick={() => handleReaction(post.id, r.type)}
                                      className="hover:scale-125 transition-transform leading-none bg-transparent border-0 p-0 cursor-pointer"
                                      style={{ fontSize: 28, lineHeight: 1 }}
                                      title={r.type}
                                    >
                                      {r.emoji}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => {
                                setExpandedComments((prev) => new Set([...prev, post.id]));
                                setTimeout(() => commentInputRefs.current[post.id]?.focus(), 100);
                              }}
                              className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                              style={{ color: '#65676B' }}
                            >
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                              </svg>
                              <span className="text-[14px] font-semibold">Comment</span>
                            </button>
                            <div style={{ position: 'relative', flex: 1 }}>
                              <button
                                onClick={() => handleShare(post.id)}
                                className="flex items-center justify-center gap-1.5 w-full py-2 rounded-md hover:bg-[#F2F3F5] transition-colors"
                                style={{ color: '#65676B' }}
                              >
                                <svg
                                  width="18"
                                  height="18"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
                                </svg>
                                <span className="text-[14px] font-semibold">Share</span>
                              </button>
                              {shareMenuPostId === post.id && (
                                <ShareMenu
                                  postId={post.id}
                                  sessionId={sessionId!}
                                  platform="facebook"
                                  authorHandle={post.author_handle}
                                  authorDisplayName={post.author_display_name}
                                  contentPreview={post.content}
                                  onClose={() => setShareMenuPostId(null)}
                                  onReposted={(repost) => handleReposted(post.id, repost)}
                                />
                              )}
                            </div>
                          </div>

                          {/* Inline Comments */}
                          {(() => {
                            const commentsExpanded = expandedComments.has(post.id);
                            const sortedReplies = [...replies].sort(
                              (a, b) =>
                                new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                            );
                            const visibleReplies = commentsExpanded
                              ? sortedReplies
                              : sortedReplies.slice(-2);
                            return (
                              <>
                                {replies.length > 0 && (
                                  <div
                                    className="px-3 pt-2 pb-1"
                                    style={{ backgroundColor: '#FFFFFF' }}
                                  >
                                    {replies.length > 2 && !commentsExpanded && (
                                      <button
                                        onClick={() =>
                                          setExpandedComments((prev) => new Set([...prev, post.id]))
                                        }
                                        className="text-[14px] font-semibold mb-2"
                                        style={{ color: '#65676B' }}
                                      >
                                        View all {replies.length} comments
                                      </button>
                                    )}
                                    {commentsExpanded && replies.length > 2 && (
                                      <button
                                        onClick={() =>
                                          setExpandedComments((prev) => {
                                            const n = new Set(prev);
                                            n.delete(post.id);
                                            return n;
                                          })
                                        }
                                        className="text-[14px] font-semibold mb-2"
                                        style={{ color: '#65676B' }}
                                      >
                                        Hide comments
                                      </button>
                                    )}
                                    {(() => {
                                      const replyIdSet = new Set(visibleReplies.map((r) => r.id));
                                      const parentComments: typeof visibleReplies = [];
                                      const childMap: Record<string, typeof visibleReplies> = {};
                                      const parentOf = new Map<string, string>();

                                      // Pass 1: classify each reply as parent or child
                                      for (const reply of visibleReplies) {
                                        const content = reply.content || '';
                                        const targetIdMatch =
                                          content.match(/^@[\w._-]+\[([^\]]+)\] /);
                                        if (targetIdMatch) {
                                          const targetId = targetIdMatch[1];
                                          if (replyIdSet.has(targetId)) {
                                            // Flatten: if target is itself a child, use its parent instead
                                            const resolvedParent =
                                              parentOf.get(targetId) || targetId;
                                            if (!childMap[resolvedParent])
                                              childMap[resolvedParent] = [];
                                            childMap[resolvedParent].push(reply);
                                            parentOf.set(reply.id, resolvedParent);
                                            continue;
                                          }
                                          parentComments.push(reply);
                                          continue;
                                        }
                                        const handleMatch = content.match(/^@([\w._-]+) /);
                                        if (handleMatch) {
                                          const parentHandle = `@${handleMatch[1]}`;
                                          const matchingParent = [...parentComments]
                                            .reverse()
                                            .find((p) => p.author_handle === parentHandle);
                                          if (matchingParent) {
                                            if (!childMap[matchingParent.id])
                                              childMap[matchingParent.id] = [];
                                            childMap[matchingParent.id].push(reply);
                                            parentOf.set(reply.id, matchingParent.id);
                                            continue;
                                          }
                                        }
                                        parentComments.push(reply);
                                      }

                                      const renderComment = (
                                        reply: SocialPost,
                                        indented: boolean,
                                      ) => {
                                        const content = reply.content || '';
                                        const targetIdMatch =
                                          content.match(/^@([\w._-]+)\[([^\]]+)\] /);
                                        const mentionMatch = content.match(/^@[\w._-]+ /);
                                        let displayContent: React.ReactNode = content;
                                        if (targetIdMatch) {
                                          const mentionedHandle = `@${targetIdMatch[1]}`;
                                          const restContent = content.slice(
                                            targetIdMatch[0].length,
                                          );
                                          const mentionedReply = visibleReplies.find(
                                            (r) => r.author_handle === mentionedHandle,
                                          );
                                          const mentionedName =
                                            mentionedReply?.author_display_name ||
                                            post.author_display_name;
                                          displayContent = (
                                            <>
                                              <span style={{ color: '#1877F2', fontWeight: 600 }}>
                                                {mentionedName}
                                              </span>{' '}
                                              {restContent}
                                            </>
                                          );
                                        } else if (mentionMatch) {
                                          const mentionedHandle = mentionMatch[0].trim();
                                          const restContent = content.slice(mentionMatch[0].length);
                                          const mentionedReply = visibleReplies.find(
                                            (r) => r.author_handle === mentionedHandle,
                                          );
                                          const mentionedName =
                                            mentionedReply?.author_display_name ||
                                            post.author_display_name;
                                          displayContent = (
                                            <>
                                              <span style={{ color: '#1877F2', fontWeight: 600 }}>
                                                {mentionedName}
                                              </span>{' '}
                                              {restContent}
                                            </>
                                          );
                                        }
                                        return (
                                          <div
                                            key={reply.id}
                                            id={`fb-reply-${reply.id}`}
                                            className={`flex gap-2 mb-2.5 ${indented ? 'ml-10' : ''}`}
                                          >
                                            <div
                                              className={`${indented ? 'w-7 h-7 text-[10px]' : 'w-8 h-8 text-[12px]'} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0`}
                                              style={{
                                                backgroundColor: getAvatarColor(
                                                  reply.author_display_name,
                                                ),
                                              }}
                                            >
                                              {reply.author_display_name.charAt(0).toUpperCase()}
                                            </div>
                                            <div>
                                              <div
                                                className="rounded-2xl px-3 py-1.5"
                                                style={{ backgroundColor: '#F0F2F5' }}
                                              >
                                                <span
                                                  className="text-[13px] font-semibold"
                                                  style={{ color: '#050505' }}
                                                >
                                                  {reply.author_display_name}
                                                </span>
                                                <p
                                                  className="text-[14px]"
                                                  style={{ color: '#050505' }}
                                                >
                                                  {displayContent}
                                                </p>
                                              </div>
                                              <div className="flex items-center gap-3 ml-3 mt-0.5">
                                                <div className="relative">
                                                  {(() => {
                                                    const cmtRx = myReactions[reply.id];
                                                    const cmtRxInfo = cmtRx
                                                      ? REACTIONS.find((r) => r.type === cmtRx)
                                                      : null;
                                                    const cmtRxColor =
                                                      cmtRx === 'like'
                                                        ? '#1877F2'
                                                        : cmtRx === 'love'
                                                          ? '#F33E58'
                                                          : cmtRx === 'angry'
                                                            ? '#E9710F'
                                                            : cmtRx
                                                              ? '#F7B928'
                                                              : '#65676B';
                                                    return (
                                                      <button
                                                        onClick={() =>
                                                          handleReaction(reply.id, 'like')
                                                        }
                                                        onMouseEnter={() => {
                                                          if (reactionTimeoutRef.current)
                                                            clearTimeout(
                                                              reactionTimeoutRef.current,
                                                            );
                                                          setShowReactions(reply.id);
                                                        }}
                                                        onMouseLeave={() => {
                                                          reactionTimeoutRef.current = setTimeout(
                                                            () => setShowReactions(null),
                                                            600,
                                                          );
                                                        }}
                                                        className="text-[12px] font-semibold hover:underline"
                                                        style={{
                                                          color: reply.liked_by_me
                                                            ? cmtRxColor
                                                            : '#65676B',
                                                        }}
                                                      >
                                                        {cmtRxInfo
                                                          ? `${cmtRxInfo.emoji} ${cmtRxInfo.type.charAt(0).toUpperCase() + cmtRxInfo.type.slice(1)}`
                                                          : 'Like'}
                                                      </button>
                                                    );
                                                  })()}
                                                  {showReactions === reply.id && (
                                                    <div
                                                      className="absolute bottom-full left-0 mb-1 flex gap-1 px-2 py-1.5 rounded-full z-50"
                                                      style={{
                                                        backgroundColor: '#FFFFFF',
                                                        boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
                                                      }}
                                                      onMouseEnter={() => {
                                                        if (reactionTimeoutRef.current)
                                                          clearTimeout(reactionTimeoutRef.current);
                                                        setShowReactions(reply.id);
                                                      }}
                                                      onMouseLeave={() => {
                                                        reactionTimeoutRef.current = setTimeout(
                                                          () => setShowReactions(null),
                                                          300,
                                                        );
                                                      }}
                                                    >
                                                      {REACTIONS.map((r) => (
                                                        <button
                                                          key={r.type}
                                                          onClick={() =>
                                                            handleReaction(reply.id, r.type)
                                                          }
                                                          className="hover:scale-125 transition-transform leading-none bg-transparent border-0 p-0 cursor-pointer"
                                                          style={{ fontSize: 22, lineHeight: 1 }}
                                                          title={r.type}
                                                        >
                                                          {r.emoji}
                                                        </button>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                                <button
                                                  onClick={() => {
                                                    setReplyTarget((prev) => ({
                                                      ...prev,
                                                      [post.id]: {
                                                        handle: reply.author_handle,
                                                        displayName: reply.author_display_name,
                                                        replyToId: reply.id,
                                                      },
                                                    }));
                                                    setCommentText((prev) => ({
                                                      ...prev,
                                                      [post.id]: '',
                                                    }));
                                                    setExpandedComments(
                                                      (prev) => new Set([...prev, post.id]),
                                                    );
                                                    setTimeout(
                                                      () =>
                                                        commentInputRefs.current[post.id]?.focus(),
                                                      100,
                                                    );
                                                  }}
                                                  className="text-[12px] font-semibold hover:underline"
                                                  style={{ color: '#65676B' }}
                                                >
                                                  Reply
                                                </button>
                                                <span
                                                  className="text-[12px]"
                                                  style={{ color: '#65676B' }}
                                                >
                                                  {timeAgo(reply.created_at)}
                                                </span>
                                                {reply.like_count > 0 && (
                                                  <span
                                                    className="text-[12px]"
                                                    style={{ color: '#65676B' }}
                                                  >
                                                    {getReactionEmoji(myReactions[reply.id])}{' '}
                                                    {reply.like_count}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      };

                                      return parentComments.map((reply) => (
                                        <div key={reply.id}>
                                          {renderComment(reply, false)}
                                          {(childMap[reply.id] || []).map((child) =>
                                            renderComment(child, true),
                                          )}
                                        </div>
                                      ));
                                    })()}
                                  </div>
                                )}

                                {/* Comment Input */}
                                {replyTarget[post.id] && (
                                  <div
                                    className="flex items-center justify-between px-3 pt-1"
                                    style={{ backgroundColor: '#FFFFFF' }}
                                  >
                                    <span className="text-[12px]" style={{ color: '#65676B' }}>
                                      Replying to{' '}
                                      <span style={{ color: '#1877F2' }}>
                                        {replyTarget[post.id]!.displayName}
                                      </span>
                                    </span>
                                    <button
                                      onClick={() =>
                                        setReplyTarget((prev) => ({ ...prev, [post.id]: null }))
                                      }
                                      className="text-[11px]"
                                      style={{ color: '#65676B' }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                                <div
                                  className="flex items-center gap-2 px-3 py-1.5 relative"
                                  style={{ backgroundColor: '#FFFFFF' }}
                                >
                                  {pageMode && orgPageInfo?.page_logo_url ? (
                                    <img
                                      src={orgPageInfo.page_logo_url}
                                      alt={orgPageInfo.page_name}
                                      className="w-6 h-6 rounded-full object-cover flex-shrink-0"
                                    />
                                  ) : (
                                    <div
                                      className="w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-[10px] flex-shrink-0"
                                      style={{ backgroundColor: pageMode ? '#4267B2' : '#1877F2' }}
                                    >
                                      {pageMode
                                        ? orgPageInfo?.page_name?.[0] || 'O'
                                        : playerDisplayName.charAt(0).toUpperCase()}
                                    </div>
                                  )}
                                  <div
                                    className="flex-1 flex items-center rounded-full px-3 py-1 relative"
                                    style={{ backgroundColor: '#F0F2F5' }}
                                  >
                                    <input
                                      ref={(el) => {
                                        commentInputRefs.current[post.id] = el;
                                      }}
                                      type="text"
                                      value={commentText[post.id] || ''}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setCommentText((prev) => ({ ...prev, [post.id]: val }));
                                        const match = val.match(/@(\w*)$/);
                                        if (match) {
                                          setMentionQuery(match[1].toLowerCase());
                                          setShowMentions(true);
                                        } else {
                                          setShowMentions(false);
                                        }
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          handleComment(post.id);
                                          setShowMentions(false);
                                        }
                                      }}
                                      placeholder="Write a comment..."
                                      className="flex-1 bg-transparent text-[13px] outline-none"
                                      style={{ color: '#050505' }}
                                    />
                                    {commentText[post.id]?.trim() && (
                                      <button
                                        onClick={() => {
                                          handleComment(post.id);
                                          setShowMentions(false);
                                        }}
                                        className="ml-1"
                                      >
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="#1877F2"
                                        >
                                          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                                        </svg>
                                      </button>
                                    )}
                                    {showMentions &&
                                      document.activeElement ===
                                        commentInputRefs.current[post.id] && (
                                        <div
                                          className="absolute left-0 right-0 bottom-full mb-1 rounded-lg overflow-hidden z-50"
                                          style={{
                                            backgroundColor: '#FFFFFF',
                                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                            maxHeight: 120,
                                            overflowY: 'auto',
                                          }}
                                        >
                                          {knownHandles
                                            .filter((h) =>
                                              h.handle.toLowerCase().includes(mentionQuery),
                                            )
                                            .slice(0, 5)
                                            .map((h) => (
                                              <button
                                                key={h.handle}
                                                onMouseDown={(e) => {
                                                  e.preventDefault();
                                                  setCommentText((prev) => ({
                                                    ...prev,
                                                    [post.id]: (prev[post.id] || '').replace(
                                                      /@\w*$/,
                                                      h.handle + ' ',
                                                    ),
                                                  }));
                                                  setShowMentions(false);
                                                  commentInputRefs.current[post.id]?.focus();
                                                }}
                                                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[#F2F3F5]"
                                                style={{ color: '#050505' }}
                                              >
                                                <span style={{ color: '#1877F2' }}>{h.handle}</span>
                                                <span
                                                  className="ml-1 text-[11px]"
                                                  style={{ color: '#65676B' }}
                                                >
                                                  {h.display_name}
                                                </span>
                                              </button>
                                            ))}
                                        </div>
                                      )}
                                  </div>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      );
                    })
                )}
                <div style={{ height: 16 }} />
              </div>

              {/* ── Compose Modal ── */}
              {composing && (
                <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
                  <div
                    className="flex-1"
                    style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
                    onClick={() => setComposing(false)}
                  />
                  <div
                    className="flex flex-col"
                    style={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '12px 12px 0 0',
                      maxHeight: '80%',
                      minHeight: 320,
                    }}
                  >
                    {/* Header */}
                    <div
                      className="flex items-center justify-between px-4 py-3"
                      style={{ borderBottom: '1px solid #DADDE1', backgroundColor: '#FFFFFF' }}
                    >
                      <button
                        onClick={() => setComposing(false)}
                        className="text-[15px] font-semibold"
                        style={{ color: '#65676B' }}
                      >
                        Cancel
                      </button>
                      <span className="font-bold text-[17px]" style={{ color: '#050505' }}>
                        Create post
                      </span>
                      <button
                        onClick={handlePost}
                        disabled={!composeText.trim()}
                        className="px-4 py-1.5 rounded-md text-[14px] font-bold text-white disabled:opacity-40"
                        style={{ backgroundColor: '#1877F2' }}
                      >
                        Post
                      </button>
                    </div>

                    {/* Format Picker */}
                    <div
                      className="px-4 pt-3 pb-1 flex gap-1.5 flex-wrap"
                      style={{ backgroundColor: '#FFFFFF' }}
                    >
                      {POST_FORMATS.map((fmt) => (
                        <button
                          key={fmt.value}
                          onClick={() => setSelectedFormat(fmt.value)}
                          className="px-2.5 py-1 rounded-full text-[12px] font-semibold transition-colors"
                          style={{
                            backgroundColor: selectedFormat === fmt.value ? '#1877F2' : '#E4E6EB',
                            color: selectedFormat === fmt.value ? '#FFFFFF' : '#65676B',
                          }}
                        >
                          {fmt.icon} {fmt.label}
                        </button>
                      ))}
                    </div>

                    {/* Post As Toggle */}
                    {orgPageInfo && (
                      <div
                        className="px-4 py-2 flex items-center gap-2"
                        style={{ backgroundColor: '#F0F2F5', borderBottom: '1px solid #E4E6EB' }}
                      >
                        <span className="text-[12px]" style={{ color: '#65676B' }}>
                          Posting as:
                        </span>
                        <button
                          onClick={() => setPostingAsPage(false)}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold"
                          style={{
                            backgroundColor: !postingAsPage ? '#E7F3FF' : 'transparent',
                            color: !postingAsPage ? '#1877F2' : '#65676B',
                            border: !postingAsPage ? '1px solid #1877F2' : '1px solid #CED0D4',
                          }}
                        >
                          You
                        </button>
                        <button
                          onClick={() => setPostingAsPage(true)}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold"
                          style={{
                            backgroundColor: postingAsPage ? '#E7F3FF' : 'transparent',
                            color: postingAsPage ? '#1877F2' : '#65676B',
                            border: postingAsPage ? '1px solid #1877F2' : '1px solid #CED0D4',
                          }}
                        >
                          &#10003; {orgPageInfo.page_name}
                        </button>
                      </div>
                    )}

                    {/* Compose Area */}
                    <div
                      className="flex-1 px-4 pb-2 overflow-y-auto"
                      style={{ backgroundColor: '#FFFFFF' }}
                    >
                      <div className="flex gap-3 pt-3">
                        {postingAsPage && orgPageInfo?.page_logo_url ? (
                          <img
                            src={orgPageInfo.page_logo_url}
                            alt={orgPageInfo.page_name}
                            className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                          />
                        ) : (
                          <div
                            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
                            style={{ backgroundColor: postingAsPage ? '#4267B2' : '#1877F2' }}
                          >
                            {postingAsPage
                              ? orgPageInfo?.page_name?.[0] || 'O'
                              : playerDisplayName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 relative">
                          <textarea
                            value={composeText}
                            onChange={(e) => {
                              const val = e.target.value;
                              setComposeText(val);
                              const match = val.match(/@(\w*)$/);
                              if (match) {
                                setMentionQuery(match[1].toLowerCase());
                                setShowMentions(true);
                              } else {
                                setShowMentions(false);
                              }
                            }}
                            placeholder="What's on your mind?"
                            className="w-full bg-transparent text-[16px] resize-none outline-none min-h-[140px]"
                            style={{ color: '#050505', lineHeight: '1.5' }}
                            maxLength={maxChars}
                            autoFocus
                          />
                          {showMentions && (
                            <div
                              className="absolute left-0 right-0 rounded-lg overflow-hidden z-50"
                              style={{
                                top: 40,
                                backgroundColor: '#FFFFFF',
                                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                maxHeight: 150,
                                overflowY: 'auto',
                              }}
                            >
                              {knownHandles
                                .filter((h) => h.handle.toLowerCase().includes(mentionQuery))
                                .slice(0, 6)
                                .map((h) => (
                                  <button
                                    key={h.handle}
                                    onClick={() => {
                                      setComposeText((prev) =>
                                        prev.replace(/@\w*$/, h.handle + ' '),
                                      );
                                      setShowMentions(false);
                                    }}
                                    className="w-full text-left px-3 py-2 text-[14px] hover:bg-[#F2F3F5]"
                                    style={{ color: '#050505' }}
                                  >
                                    <span style={{ color: '#1877F2' }}>{h.handle}</span>
                                    <span className="ml-2 text-[12px]" style={{ color: '#65676B' }}>
                                      {h.display_name}
                                    </span>
                                  </button>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Media preview */}
                    {mediaPreviewUrl && !showMediaPanel && (
                      <div
                        className="mx-4 mb-2 rounded-xl overflow-hidden relative"
                        style={{ border: '1px solid #DADDE1' }}
                      >
                        {mediaPreviewUrl.endsWith('.mp4') ? (
                          <video
                            src={mediaPreviewUrl}
                            controls
                            className="w-full max-h-[200px] object-contain"
                            style={{ backgroundColor: '#F0F2F5' }}
                          />
                        ) : (
                          <img
                            src={mediaPreviewUrl}
                            alt="Media preview"
                            className="w-full max-h-[200px] object-contain"
                            style={{ backgroundColor: '#F0F2F5' }}
                          />
                        )}
                        <div className="absolute top-2 right-2 flex gap-1">
                          <button
                            onClick={() => setShowMediaPanel(true)}
                            className="px-2 py-1 rounded text-[11px] font-semibold"
                            style={{ backgroundColor: 'rgba(255,255,255,0.9)', color: '#1877F2' }}
                          >
                            Change
                          </button>
                          <button
                            onClick={() => {
                              setMediaPreviewUrl(null);
                              setMediaPromptText('');
                            }}
                            className="px-2 py-1 rounded text-[11px] font-semibold"
                            style={{ backgroundColor: 'rgba(255,255,255,0.9)', color: '#e74c3c' }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Media panel */}
                    {showMediaPanel && (
                      <div
                        className="mx-4 mb-2 rounded-xl p-3"
                        style={{ backgroundColor: '#F0F2F5', border: '1px solid #DADDE1' }}
                      >
                        <div
                          className="flex items-center gap-1 mb-3 rounded-lg overflow-hidden"
                          style={{ backgroundColor: '#FFFFFF' }}
                        >
                          <button
                            onClick={() => setMediaType('image')}
                            className="flex-1 py-2 text-[13px] font-semibold text-center"
                            style={{
                              backgroundColor: mediaType === 'image' ? '#1877F2' : 'transparent',
                              color: mediaType === 'image' ? '#fff' : '#65676B',
                            }}
                          >
                            Image
                          </button>
                          <button
                            onClick={() => setMediaType('video')}
                            className="flex-1 py-2 text-[13px] font-semibold text-center"
                            style={{
                              backgroundColor: mediaType === 'video' ? '#1877F2' : 'transparent',
                              color: mediaType === 'video' ? '#fff' : '#65676B',
                            }}
                          >
                            Video
                          </button>
                        </div>
                        <textarea
                          autoFocus
                          value={mediaPromptText}
                          onChange={(e) => setMediaPromptText(e.target.value)}
                          placeholder={
                            mediaType === 'video'
                              ? 'Describe your video concept...'
                              : 'Describe the image you want to create...'
                          }
                          className="w-full rounded-lg px-3 py-2 text-[14px] outline-none resize-none"
                          style={{
                            backgroundColor: '#FFFFFF',
                            color: '#050505',
                            border: '1px solid #DADDE1',
                            minHeight: 50,
                          }}
                          rows={2}
                          maxLength={500}
                        />
                        {mediaType === 'video' && (
                          <div className="mt-2 flex gap-3">
                            <div className="flex-1">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px]" style={{ color: '#65676B' }}>
                                  Duration
                                </span>
                                <span
                                  className="text-[11px] font-bold"
                                  style={{ color: '#1877F2' }}
                                >
                                  {videoDuration}s
                                </span>
                              </div>
                              <input
                                type="range"
                                min={5}
                                max={15}
                                step={1}
                                value={videoDuration}
                                onChange={(e) => setVideoDuration(Number(e.target.value))}
                                className="w-full accent-[#1877F2]"
                                style={{ height: 4 }}
                              />
                            </div>
                            <div>
                              <span className="text-[11px] block mb-1" style={{ color: '#65676B' }}>
                                Orientation
                              </span>
                              <div className="flex gap-1">
                                {(
                                  [
                                    ['16:9', 'Landscape'],
                                    ['9:16', 'Portrait'],
                                    ['1:1', 'Square'],
                                  ] as const
                                ).map(([ratio, label]) => (
                                  <button
                                    key={ratio}
                                    onClick={() => setVideoOrientation(ratio)}
                                    className="px-2 py-1.5 rounded text-[10px] font-semibold"
                                    style={{
                                      backgroundColor:
                                        videoOrientation === ratio ? '#1877F2' : '#E4E6EB',
                                      color: videoOrientation === ratio ? '#fff' : '#65676B',
                                    }}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                        {mediaGenerating && (
                          <div className="flex items-center gap-2 mt-2 px-1">
                            <div
                              className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                              style={{ borderColor: '#1877F2', borderTopColor: 'transparent' }}
                            />
                            <span className="text-[12px]" style={{ color: '#65676B' }}>
                              {mediaType === 'video'
                                ? 'Generating video...'
                                : 'Generating image...'}
                            </span>
                          </div>
                        )}
                        {mediaPreviewUrl && (
                          <div
                            className="mt-2 rounded-lg overflow-hidden"
                            style={{ border: '1px solid #DADDE1' }}
                          >
                            {mediaPreviewUrl.endsWith('.mp4') ? (
                              <video
                                src={mediaPreviewUrl}
                                controls
                                className="w-full max-h-[180px] object-contain"
                                style={{ backgroundColor: '#F0F2F5' }}
                              />
                            ) : (
                              <img
                                src={mediaPreviewUrl}
                                alt="Preview"
                                className="w-full max-h-[180px] object-contain"
                                style={{ backgroundColor: '#F0F2F5' }}
                              />
                            )}
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex gap-2">
                            {mediaPreviewUrl && (
                              <button
                                onClick={() => {
                                  setMediaPreviewUrl(null);
                                  handleGeneratePreview();
                                }}
                                className="text-[12px] font-semibold px-3 py-1.5 rounded-full"
                                style={{ backgroundColor: '#E4E6EB', color: '#050505' }}
                              >
                                Regenerate
                              </button>
                            )}
                            <button
                              onClick={() => setShowMediaPanel(false)}
                              className="text-[12px] font-semibold px-3 py-1.5 rounded-full"
                              style={{ backgroundColor: '#1877F2', color: '#fff' }}
                            >
                              Done
                            </button>
                          </div>
                          {!mediaPreviewUrl && !mediaGenerating && (
                            <button
                              disabled={!mediaPromptText.trim()}
                              onClick={handleGeneratePreview}
                              className="text-[12px] font-semibold px-3 py-1.5 rounded-full disabled:opacity-40"
                              style={{ backgroundColor: '#1877F2', color: '#fff' }}
                            >
                              Generate
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Bottom toolbar */}
                    <div
                      className="flex items-center justify-between px-4 py-2.5"
                      style={{ borderTop: '1px solid #DADDE1', backgroundColor: '#FFFFFF' }}
                    >
                      <div className="flex items-center gap-4">
                        <button
                          onClick={() => {
                            setShowMediaPanel(!showMediaPanel);
                            setMediaType('image');
                          }}
                          className="outline-none focus:outline-none hover:opacity-70"
                        >
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                            <rect
                              x="3"
                              y="3"
                              width="18"
                              height="18"
                              rx="3"
                              stroke="#45BD62"
                              strokeWidth="2"
                            />
                            <circle cx="8.5" cy="8.5" r="1.5" fill="#45BD62" />
                            <path
                              d="M21 15l-5-5L5 21"
                              stroke="#45BD62"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={() => {
                            setShowMediaPanel(!showMediaPanel);
                            setMediaType('video');
                          }}
                          className="outline-none focus:outline-none hover:opacity-70"
                        >
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                            <rect
                              x="2"
                              y="4"
                              width="20"
                              height="16"
                              rx="2"
                              stroke="#F44336"
                              strokeWidth="2"
                            />
                            <polygon points="10 9 15 12 10 15" fill="#F44336" />
                          </svg>
                        </button>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="9" stroke="#F7B928" strokeWidth="2" />
                          <path
                            d="M8 14s1.5 2 4 2 4-2 4-2"
                            stroke="#F7B928"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                          <circle cx="9" cy="9" r="1" fill="#F7B928" />
                          <circle cx="15" cy="9" r="1" fill="#F7B928" />
                        </svg>
                      </div>
                      <span className="text-[13px]" style={{ color: '#65676B' }}>
                        {composeText.length}/{maxChars}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile Bottom Nav (phone mode only) ── */}
      {!isDesktopWidth && (
        <div
          className="flex-shrink-0 flex items-center justify-around py-2 px-1"
          style={{ backgroundColor: '#FFFFFF', borderTop: '1px solid #DADDE1' }}
        >
          {[
            {
              label: 'Home',
              view: 'feed' as const,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill={activeView === 'feed' ? '#1877F2' : 'none'}
                  stroke={activeView === 'feed' ? '#1877F2' : '#65676B'}
                  strokeWidth="2"
                >
                  <path d="M3 9.5L12 2l9 7.5V22H15v-6H9v6H3V9.5z" />
                </svg>
              ),
            },
            {
              label: 'Groups',
              view: 'groups' as const,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={activeView === 'groups' ? '#1877F2' : '#65676B'}
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
              ),
            },
            {
              label: 'Events',
              view: 'events' as const,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={activeView === 'events' ? '#1877F2' : '#65676B'}
                  strokeWidth="2"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              ),
            },
            {
              label: 'Chat',
              view: 'messenger' as const,
              icon: (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={activeView === 'messenger' ? '#1877F2' : '#65676B'}
                  strokeWidth="2"
                >
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              ),
            },
          ].map((tab) => (
            <button
              key={tab.label}
              onClick={() => {
                setActiveView(tab.view);
                setShowNotifPanel(false);
              }}
              className="flex flex-col items-center py-1 px-3"
            >
              {tab.icon}
              <span
                className="text-[10px] mt-0.5"
                style={{ color: activeView === tab.view ? '#1877F2' : '#65676B' }}
              >
                {tab.label}
              </span>
            </button>
          ))}
          {orgPageInfo && (
            <button
              onClick={() => {
                setPageMode((prev) => {
                  const next = !prev;
                  setPostingAsPage(next);
                  return next;
                });
                setActiveView('feed');
                setShowNotifPanel(false);
              }}
              className="flex flex-col items-center py-1 px-3"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill={pageMode ? '#1877F2' : 'none'}
                stroke={pageMode ? '#1877F2' : '#65676B'}
                strokeWidth="2"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span
                className="text-[10px] mt-0.5"
                style={{ color: pageMode ? '#1877F2' : '#65676B' }}
              >
                Page
              </span>
            </button>
          )}
        </div>
      )}

      {/* ── Chat Boxes (anchored bottom-right, desktop only) ── */}
      {isDesktopWidth && (
        <div className="absolute bottom-0 right-3 flex items-end gap-2 z-50 pointer-events-none">
          {openChats.map((chat) => {
            const messages = chatMessages[chat.threadId] || [];
            return (
              <div
                key={chat.threadId}
                className="pointer-events-auto flex flex-col rounded-t-lg overflow-hidden"
                style={{
                  width: 328,
                  height: 420,
                  backgroundColor: '#FFFFFF',
                  boxShadow: '0 -2px 12px rgba(0,0,0,0.15)',
                }}
              >
                {/* Chat Header */}
                <div
                  className="flex items-center justify-between px-3 py-2"
                  style={{ backgroundColor: '#FFFFFF', borderBottom: '1px solid #E4E6EB' }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[12px]"
                      style={{ backgroundColor: getAvatarColor(chat.displayName) }}
                    >
                      {chat.displayName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-[14px] font-semibold" style={{ color: '#050505' }}>
                      {chat.displayName}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setActiveView('messenger');
                        setOpenChats((prev) => prev.filter((c) => c.threadId !== chat.threadId));
                      }}
                      className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-[#F0F2F5]"
                      title="Open full screen"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#65676B"
                        strokeWidth="2"
                      >
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    </button>
                    <button
                      onClick={() =>
                        setOpenChats((prev) => prev.filter((c) => c.threadId !== chat.threadId))
                      }
                      className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-[#F0F2F5]"
                      title="Close"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#65676B"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Messages */}
                <div
                  className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1"
                  style={{ backgroundColor: '#FFFFFF' }}
                >
                  {messages.map((msg) => {
                    const isMe = msg.sender_handle !== chat.handle;
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className="max-w-[75%] px-3 py-1.5 rounded-2xl text-[14px]"
                          style={{
                            backgroundColor: isMe ? '#1877F2' : '#F0F2F5',
                            color: isMe ? '#FFFFFF' : '#050505',
                          }}
                        >
                          {msg.content}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Input */}
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ borderTop: '1px solid #E4E6EB' }}
                >
                  <input
                    type="text"
                    value={chatInputs[chat.threadId] || ''}
                    onChange={(e) =>
                      setChatInputs((prev) => ({ ...prev, [chat.threadId]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') sendChatMessage(chat.threadId, chat.handle);
                    }}
                    placeholder="Aa"
                    className="flex-1 px-3 py-1.5 rounded-full text-[14px] outline-none"
                    style={{ backgroundColor: '#F0F2F5', color: '#050505' }}
                  />
                  <button
                    onClick={() => sendChatMessage(chat.threadId, chat.handle)}
                    className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ color: '#1877F2' }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#1877F2">
                      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
