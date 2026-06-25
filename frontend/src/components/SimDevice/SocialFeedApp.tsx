import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { usePageMode } from '../../contexts/PageModeContext';
import { supabase } from '../../lib/supabase';
import OrgPageView from './OrgPageView';
import PlayerActivityPanel from './PlayerActivityPanel';
import ShareMenu from './ShareMenu';
import { LinkPreviewCard } from './LinkPreviewCard';
import DisputeModal from './DisputeModal';
import ReportModal from './ReportModal';

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

const REACTION_EMOJI: Record<string, string> = {
  like: '\u{1F44D}',
  love: '\u2764\uFE0F',
  haha: '\u{1F602}',
  wow: '\u{1F62E}',
  angry: '\u{1F621}',
  sad: '\u{1F622}',
};

type PostFormat =
  | 'text'
  | 'official_statement'
  | 'infographic'
  | 'humor_meme'
  | 'video_concept'
  | 'personal_story';

const POST_FORMATS: Array<{ value: PostFormat; label: string; icon: string; placeholder: string }> =
  [
    { value: 'text', label: 'Text', icon: '✏️', placeholder: "What's happening?" },
    {
      value: 'official_statement',
      label: 'Statement',
      icon: '📋',
      placeholder: 'Draft your official statement...',
    },
    {
      value: 'infographic',
      label: 'Infographic',
      icon: '📊',
      placeholder: 'Describe your infographic content...',
    },
    {
      value: 'humor_meme',
      label: 'Meme/Humor',
      icon: '😄',
      placeholder: 'Describe your meme or humorous post concept...',
    },
    {
      value: 'video_concept',
      label: 'Video',
      icon: '🎬',
      placeholder: 'Describe your video concept...',
    },
    {
      value: 'personal_story',
      label: 'Story',
      icon: '💬',
      placeholder: 'Share a personal story or testimony...',
    },
  ];

const FORMAT_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  official_statement: { label: 'Official Statement', bg: 'rgba(29,155,240,0.15)', fg: '#1D9BF0' },
  infographic: { label: 'Infographic', bg: 'rgba(0,186,124,0.15)', fg: '#00BA7C' },
  humor_meme: { label: 'Meme/Humor', bg: 'rgba(249,24,128,0.15)', fg: '#F91880' },
  video_concept: { label: 'Video', bg: 'rgba(120,86,255,0.15)', fg: '#7856FF' },
  personal_story: { label: 'Personal Story', bg: 'rgba(255,122,0,0.15)', fg: '#FF7A00' },
};

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
  created_at: string;
  platform: string;
  virality_score: number;
  reply_to_post_id: string | null;
  liked_by_me?: boolean;
  flagged_by_me?: boolean;
  post_format?: string;
  media_urls?: string[];
  posted_by_display_name?: string;
  is_branded_history?: boolean;
  target_player_ids?: string[];
  reaction_types?: string[];
  reaction_summary?: string[];
  is_surfaced_to_session?: boolean;
}

function formatCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function SocialFeedApp({
  externalFilter,
  openPostId,
  triggerCompose,
}: { externalFilter?: string; openPostId?: string; triggerCompose?: number } = {}) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { isTrainer } = useRoleVisibility();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [postingAsPage, setPostingAsPage] = useState(false);
  const { setIsPageMode } = usePageMode();
  const [orgPageInfo, setOrgPageInfo] = useState<{
    page_name: string;
    page_handle: string;
    page_logo_url?: string;
  } | null>(null);
  // Logos for every org page in the session, keyed by page handle (for rendering post avatars).
  const [orgPageLogos, setOrgPageLogos] = useState<Record<string, string>>({});
  const [overlayView, setOverlayView] = useState<'page' | 'profile' | null>(null);
  // When set, the page overlay shows this org page read-only (a rival/other brand).
  const [viewedPageHandle, setViewedPageHandle] = useState<string | null>(null);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const prevExternalFilter = useRef(externalFilter);
  const currentUserIdRef = useRef<string | null>(null);
  const [playerDisplayName, setPlayerDisplayName] = useState('Player');

  useEffect(() => {
    setIsPageMode(overlayView === 'page');
    return () => setIsPageMode(false);
  }, [overlayView, setIsPageMode]);

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
        const res = await fetch(apiUrl(`/api/social/my-page/session/${sessionId}`), { headers });
        const json = await res.json();
        const twPage = json.data?.x_twitter as Record<string, string> | null | undefined;
        if (twPage)
          setOrgPageInfo({
            page_name: twPage.page_name,
            page_handle: twPage.page_handle,
            page_logo_url: twPage.page_logo_url || '',
          });
        else setOrgPageInfo(null);

        // Load logos for ALL org pages (any player can see page-post avatars).
        const allRes = await fetch(apiUrl(`/api/social/org-page/session/${sessionId}`), {
          headers,
        });
        const allJson = await allRes.json();
        const logoMap: Record<string, string> = {};
        for (const pg of (allJson.data || []) as Array<Record<string, string>>) {
          if (pg.page_handle && pg.page_logo_url) logoMap[pg.page_handle] = pg.page_logo_url;
        }
        setOrgPageLogos(logoMap);
      } catch {
        /* non-critical */
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    if (externalFilter && externalFilter !== prevExternalFilter.current) {
      setSearchQuery(externalFilter);
    }
    prevExternalFilter.current = externalFilter;
  }, [externalFilter]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [replyingTo, setReplyingTo] = useState<SocialPost | null>(null);
  const [activeTab, setActiveTab] = useState<'foryou' | 'latest'>('foryou');
  const [selectedFormat, setSelectedFormat] = useState<PostFormat>('text');
  const [selectedPost, setSelectedPost] = useState<SocialPost | null>(null);
  const [disputePost, setDisputePost] = useState<SocialPost | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [disputing, setDisputing] = useState(false);
  const [disputeStatus, setDisputeStatus] = useState<string | null>(null);
  const [reportPost, setReportPost] = useState<SocialPost | null>(null);
  const [reportCategory, setReportCategory] = useState('');
  const [reportReason, setReportReason] = useState('');
  const [reporting, setReporting] = useState(false);
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const selectedPostRef = useRef<SocialPost | null>(null);
  const [threadReplies, setThreadReplies] = useState<SocialPost[]>([]);
  const [highlightReplyId, setHighlightReplyId] = useState<string | null>(null);
  const [knownHandles, setKnownHandles] = useState<Array<{ handle: string; display_name: string }>>(
    [],
  );
  const [mentionQuery, setMentionQuery] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
  const [mediaPromptText, setMediaPromptText] = useState('');
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaGenerating, setMediaGenerating] = useState(false);
  const [videoDuration, setVideoDuration] = useState(10);
  const [videoOrientation, setVideoOrientation] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [shareMenuPostId, setShareMenuPostId] = useState<string | null>(null);
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
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const loadPosts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        apiUrl(`/api/social/posts/session/${sessionId}?platform=x_twitter&limit=1000`),
        {
          headers,
        },
      );
      const result = await res.json();
      if (result.data) setPosts(result.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
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

  useEffect(() => {
    if (location.pathname.includes('/social')) loadPosts();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll notification count (Z platform only)
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
          const inPageMode = overlayView === 'page';
          const zCount = all.filter(
            (n: { type: string; metadata?: Record<string, unknown> }) =>
              socialTypes.includes(n.type) &&
              (!n.metadata?.platform || n.metadata.platform === 'x_twitter') &&
              (!inPageMode || n.metadata?.is_page_notification === true),
          ).length;
          setNotifCount(zCount);
        }
      } catch {
        /* ignore */
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, 15000);
    return () => clearInterval(interval);
  }, [sessionId, overlayView]);

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
        const inPageMode = overlayView === 'page';
        const isZNotif = (n: {
          type: string;
          read?: boolean;
          metadata?: Record<string, unknown>;
        }) =>
          socialTypes.includes(n.type) &&
          (!n.metadata?.platform || n.metadata.platform === 'x_twitter') &&
          (!inPageMode || n.metadata?.is_page_notification === true);
        const unreadSocial = all.filter(
          (n: { type: string; read: boolean; metadata?: Record<string, unknown> }) =>
            isZNotif(n) && !n.read,
        ).length;
        setNotifCount(unreadSocial);
      }
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
      'social_post.surfaced',
      'social_post.flagged',
      'social_post.removed',
      'social_posts.engagement_update',
      'social_post.media_updated',
      'notification.created',
    ],
    onEvent: (event) => {
      if (event.type === 'social_post.removed') {
        const { post_id } = event.data as { post_id: string };
        setPosts((prev) => prev.filter((p) => p.id !== post_id));
        setSelectedPost((prev) => (prev && prev.id === post_id ? null : prev));
        return;
      }
      if (event.type === 'social_posts.engagement_update') {
        const updates = (
          event.data as {
            updates: Array<{
              id: string;
              like_count?: number;
              view_count?: number;
              repost_count?: number;
              reaction_type?: string;
            }>;
          }
        ).updates;
        if (Array.isArray(updates)) {
          setPosts((prev) =>
            prev.map((p) => {
              const up = updates.find((u) => u.id === p.id);
              if (!up) return p;
              const reactionTypes =
                up.reaction_type && !(p.reaction_types || []).includes(up.reaction_type)
                  ? [...(p.reaction_types || []), up.reaction_type]
                  : p.reaction_types;
              return {
                ...p,
                like_count: up.like_count ?? p.like_count,
                view_count: up.view_count ?? p.view_count,
                repost_count: up.repost_count ?? p.repost_count,
                reaction_types: reactionTypes,
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
        if (newPost.platform && newPost.platform !== 'x_twitter') return;
        const isOwnPost =
          currentUserIdRef.current &&
          (newPost as unknown as Record<string, unknown>).user_id === currentUserIdRef.current;
        // Posts the player composed as the org page live in OrgPageView's separate
        // state, so they are NOT optimistically inserted into this feed. They must come
        // through the live event (dedup by id guards against double inserts when the
        // page post was composed from within this feed).
        const isOwnPagePost = isOwnPost && newPost.author_type === 'official_account';

        if (newPost.reply_to_post_id) {
          if (!isOwnPost) {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === newPost.reply_to_post_id
                  ? { ...p, reply_count: (p.reply_count || 0) + 1 }
                  : p,
              ),
            );

            const currentSelected = selectedPostRef.current;
            setThreadReplies((prev) => {
              if (currentSelected && currentSelected.id === newPost.reply_to_post_id) {
                if (prev.some((r) => r.id === newPost.id)) return prev;
                return [...prev, newPost];
              }
              return prev;
            });

            if (currentSelected && currentSelected.id === newPost.reply_to_post_id) {
              setSelectedPost((prev) =>
                prev ? { ...prev, reply_count: (prev.reply_count || 0) + 1 } : prev,
              );
            }
          }
        } else {
          if (!isOwnPost || isOwnPagePost) {
            setPosts((prev) => {
              if (prev.some((p) => p.id === newPost.id)) return prev;
              return [newPost, ...prev];
            });
          }
        }
      } else if (event.type === 'social_post.surfaced') {
        // A teammate engaged a targeted post; promote it into this feed.
        const surfaced = (event.data as { post: SocialPost }).post;
        if (!surfaced || surfaced.platform !== 'x_twitter') return;
        if (surfaced.reply_to_post_id) return;
        setPosts((prev) => {
          if (prev.some((p) => p.id === surfaced.id)) {
            return prev.map((p) => (p.id === surfaced.id ? { ...p, ...surfaced } : p));
          }
          return [surfaced, ...prev];
        });
      } else if (event.type === 'notification.created') {
        const eventData = event.data as { user_id?: string } | undefined;
        if (!eventData?.user_id || eventData.user_id === currentUserIdRef.current) {
          setNotifCount((c) => c + 1);
        }
      }
    },
  });

  async function handlePost() {
    if (!composeText.trim() || !sessionId) return;
    try {
      const headers = await getAuthHeaders();
      const postRes = await fetch(apiUrl('/api/social/posts'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          content: composeText,
          reply_to_post_id: replyingTo
            ? selectedPost?.id || replyingTo.reply_to_post_id || replyingTo.id
            : undefined,
          post_format: replyingTo ? 'text' : selectedFormat,
          ...(mediaPromptText ? { image_prompt: mediaPromptText } : {}),
          ...(mediaPreviewUrl ? { media_url: mediaPreviewUrl } : {}),
          post_as_page: postingAsPage,
        }),
      });
      if (!postRes.ok) {
        const errBody = await postRes.json().catch(() => ({}));
        console.error('Post failed:', postRes.status, errBody);
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

      const wasReplyingTo = replyingTo;

      setComposeText('');
      setMediaPromptText('');
      setMediaPreviewUrl(null);
      setShowMediaPanel(false);
      setShowEmojiPicker(false);
      setMediaGenerating(false);
      setComposing(false);
      setReplyingTo(null);
      setSelectedFormat('text');
      setPostingAsPage(false);

      if (wasReplyingTo && selectedPost) {
        setTimeout(() => openThread(selectedPost), 800);
      }
    } catch {
      /* ignore */
    }
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
        // Poll for video completion
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

  async function handleLike(postId: string) {
    const post = posts.find((p) => p.id === postId) || threadReplies.find((r) => r.id === postId);
    if (!post) return;

    const wasLiked = !!post.liked_by_me;

    const update = (p: SocialPost) =>
      p.id === postId
        ? {
            ...p,
            like_count: wasLiked ? Math.max(0, p.like_count - 1) : p.like_count + 1,
            liked_by_me: !wasLiked,
          }
        : p;
    const rollback = (p: SocialPost) =>
      p.id === postId
        ? {
            ...p,
            like_count: wasLiked ? p.like_count + 1 : Math.max(0, p.like_count - 1),
            liked_by_me: wasLiked,
          }
        : p;

    setPosts((prev) => prev.map(update));
    setSelectedPost((prev) => (prev ? update(prev) : prev));
    setThreadReplies((prev) => prev.map(update));

    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/like`), {
        method: wasLiked ? 'DELETE' : 'POST',
        headers,
        body: wasLiked ? undefined : JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      setPosts((prev) => prev.map(rollback));
      setSelectedPost((prev) => (prev ? rollback(prev) : prev));
      setThreadReplies((prev) => prev.map(rollback));
    }
  }

  async function openThread(post: SocialPost, highlightId?: string) {
    setSelectedPost(post);
    selectedPostRef.current = post;
    setThreadReplies([]);
    setHighlightReplyId(highlightId || null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${post.id}`), { headers });
      const result = await res.json();
      if (result.data?.replies) {
        setThreadReplies(result.data.replies);
      }
    } catch {
      /* ignore */
    }
  }

  // Auto-scroll and highlight a specific reply in the thread
  useEffect(() => {
    if (highlightReplyId && threadReplies.length > 0) {
      setTimeout(() => {
        const el = document.getElementById(`thread-reply-${highlightReplyId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.style.transition = 'background-color 0.3s';
          el.style.backgroundColor = 'rgba(29,155,240,0.15)';
          setTimeout(() => {
            el.style.backgroundColor = '';
          }, 2500);
        }
        setHighlightReplyId(null);
      }, 200);
    }
  }, [threadReplies, highlightReplyId]);

  // Open thread when openPostId prop is set or ?post= query param exists
  const urlPostId = new URLSearchParams(location.search).get('post');
  const effectiveOpenPostId = openPostId || urlPostId;

  useEffect(() => {
    if (!effectiveOpenPostId || posts.length === 0) return;
    const post = posts.find((p) => p.id === effectiveOpenPostId);
    if (post) openThread(post);
  }, [effectiveOpenPostId, posts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open compose when triggered externally
  useEffect(() => {
    if (triggerCompose && triggerCompose > 0) {
      setSelectedPost(null);
      setReplyingTo(null);
      setComposing(true);
    }
  }, [triggerCompose]);

  async function handleFlag(postId: string) {
    const post = posts.find((p) => p.id === postId);
    if (post?.flagged_by_me) return;

    const flagOn = (p: SocialPost) =>
      p.id === postId ? { ...p, flagged_by_me: true, is_flagged_by_player: true } : p;
    const flagOff = (p: SocialPost) => (p.id === postId ? { ...p, flagged_by_me: false } : p);

    setPosts((prev) => prev.map(flagOn));
    setSelectedPost((prev) => (prev ? flagOn(prev) : prev));

    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/posts/${postId}/flag`), {
        method: 'POST',
        headers,
      });
    } catch {
      setPosts((prev) => prev.map(flagOff));
      setSelectedPost((prev) => (prev ? flagOff(prev) : prev));
    }
  }

  function openReportModal(post: SocialPost) {
    setReportPost(post);
    setReportCategory('');
    setReportReason('');
    setReportStatus(null);
  }

  async function submitReport() {
    if (!reportPost || !reportCategory) return;
    setReporting(true);
    const postId = reportPost.id;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${postId}/report`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          violation_category: reportCategory,
          reason_text: reportReason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setReportStatus(err.error || 'Failed to submit report');
        return;
      }
      const flagOn = (p: SocialPost) =>
        p.id === postId ? { ...p, flagged_by_me: true, is_flagged_by_player: true } : p;
      setPosts((prev) => prev.map(flagOn));
      setSelectedPost((prev) => (prev ? flagOn(prev) : prev));
      setReportPost(null);
    } catch {
      setReportStatus('Failed to submit report');
    } finally {
      setReporting(false);
    }
  }

  function handleShareMenu(postId: string) {
    setShareMenuPostId((prev) => (prev === postId ? null : postId));
  }

  function openDisputeModal(post: SocialPost) {
    setDisputePost(post);
    setDisputeNote('');
    setDisputeStatus(null);
  }

  async function submitPostDispute() {
    if (!disputePost || !sessionId) return;
    setDisputing(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl('/api/social/disputes'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          target_type: 'post',
          target_id: disputePost.id,
          claimed_falsehood: disputeNote.trim(),
          submitted_facts: '',
        }),
      });
      if (res.ok) {
        setDisputePost(null);
      } else {
        const err = await res.json().catch(() => ({}));
        setDisputeStatus(err.error || 'Failed to file dispute');
      }
    } catch {
      setDisputeStatus('Failed to file dispute');
    } finally {
      setDisputing(false);
    }
  }

  async function handleRepost(postId: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/posts/${postId}/repost`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (res.ok) {
        const json = await res.json();
        setPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, repost_count: p.repost_count + 1 } : p)),
        );
        if (json.data?.id) {
          setPosts((prev) => [json.data as SocialPost, ...prev]);
        }
      }
    } catch {
      // silently fail
    }
  }

  function handleReposted(postId: string, repost: Record<string, unknown>) {
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, repost_count: p.repost_count + 1 } : p)),
    );
    if (repost?.id) {
      setPosts((prev) => [repost as unknown as SocialPost, ...prev]);
    }
    setShareMenuPostId(null);
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function getSentimentBorder(sentiment: string): string {
    switch (sentiment) {
      case 'hateful':
        return '3px solid #EF4444';
      case 'inflammatory':
        return '3px solid #F97316';
      case 'negative':
        return '3px solid #EAB308';
      case 'supportive':
        return '3px solid #22C55E';
      case 'positive':
        return '3px solid #3B82F6';
      default:
        return 'none';
    }
  }

  function getAuthorBadge(type: string): { label: string; color: string } | null {
    switch (type) {
      case 'npc_media':
        return { label: '✓', color: '#1D9BF0' };
      case 'npc_politician':
        return { label: '🏛️', color: '#7C3AED' };
      case 'npc_influencer':
        return { label: '⭐', color: '#F59E0B' };
      case 'player':
        return { label: '👤', color: '#22C55E' };
      case 'official_account':
        return { label: '✓', color: '#FFD700' };
      default:
        return null;
    }
  }

  function getAvatarColor(name: string): string {
    const colors = ['#1D9BF0', '#7856FF', '#F91880', '#FF7A00', '#00BA7C', '#FFD400'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  if (selectedPost) {
    const badge = getAuthorBadge(selectedPost.author_type);
    return (
      <div
        className="h-full flex flex-col overflow-hidden"
        style={{ backgroundColor: '#000000', color: '#E7E9EA', maxWidth: '100%' }}
      >
        {/* Thread Header */}
        <div
          className="flex items-center gap-3 px-4 flex-shrink-0"
          style={{ height: 53, borderBottom: '1px solid #2F3336' }}
        >
          <button
            onClick={() => {
              setSelectedPost(null);
              selectedPostRef.current = null;
              setThreadReplies([]);
            }}
            className="ios-btn-bounce"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#E7E9EA">
              <path d="M7.414 13l5.293 5.293a1 1 0 0 1-1.414 1.414l-7-7a1 1 0 0 1 0-1.414l7-7a1 1 0 1 1 1.414 1.414L7.414 11H20a1 1 0 1 1 0 2H7.414z" />
            </svg>
          </button>
          <span className="text-[17px] font-bold">Post</span>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Original Post (expanded) */}
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid #2F3336' }}>
            <div className="flex items-center gap-3 mb-3">
              {selectedPost.author_type === 'official_account' &&
              orgPageLogos[selectedPost.author_handle] ? (
                <img
                  src={orgPageLogos[selectedPost.author_handle]}
                  alt={selectedPost.author_display_name}
                  className="w-11 h-11 rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-[18px]"
                  style={{ backgroundColor: getAvatarColor(selectedPost.author_display_name) }}
                >
                  {selectedPost.author_display_name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <div className="flex items-center gap-1">
                  <span className="font-bold text-[15px]">{selectedPost.author_display_name}</span>
                  {badge && (
                    <span className="text-[14px]" style={{ color: badge.color }}>
                      {badge.label}
                    </span>
                  )}
                </div>
                <span className="text-[13px]" style={{ color: '#71767B' }}>
                  {selectedPost.author_handle}
                </span>
              </div>
            </div>
            <p className="text-[17px] leading-relaxed mb-3 whitespace-pre-wrap">
              {selectedPost.content}
            </p>
            {Array.isArray(selectedPost.media_urls) && selectedPost.media_urls.length > 0 && (
              <div className="mb-3 rounded-xl">
                {/\.(mp4|webm|mov)(\?|$)/i.test(selectedPost.media_urls[0]) ? (
                  <video
                    src={selectedPost.media_urls[0]}
                    controls
                    className="w-full rounded-xl"
                    style={{ backgroundColor: '#000' }}
                  />
                ) : (
                  <img
                    src={selectedPost.media_urls[0]}
                    alt=""
                    className="w-full rounded-xl"
                    style={{ backgroundColor: '#16181C' }}
                  />
                )}
              </div>
            )}
            <div className="text-[13px] mb-3" style={{ color: '#71767B' }}>
              {new Date(selectedPost.created_at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              {' · '}
              {new Date(selectedPost.created_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
            <div
              className="flex items-center gap-5 py-2 text-[13px]"
              style={{ borderTop: '1px solid #2F3336', color: '#71767B' }}
            >
              <span>
                <strong style={{ color: '#E7E9EA' }}>
                  {formatCount(selectedPost.reply_count)}
                </strong>{' '}
                Replies
              </span>
              <span>
                <strong style={{ color: '#E7E9EA' }}>
                  {formatCount(selectedPost.repost_count)}
                </strong>{' '}
                Reposts
              </span>
              <span>
                <strong style={{ color: '#E7E9EA' }}>{formatCount(selectedPost.like_count)}</strong>{' '}
                Likes
              </span>
            </div>
            <div
              className="flex items-center justify-around py-2"
              style={{ borderTop: '1px solid #2F3336' }}
            >
              {/* Reply */}
              <button
                onClick={() => {
                  setReplyingTo(selectedPost);
                  setComposeText(`${selectedPost.author_handle} `);
                  setComposing(true);
                }}
                className="ios-btn-bounce p-2 group hover:text-[#1D9BF0] transition-colors"
                style={{ color: '#71767B' }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </button>
              {/* Like */}
              <button
                onClick={() => handleLike(selectedPost.id)}
                className="ios-btn-bounce p-2 transition-colors"
                style={{ color: selectedPost.liked_by_me ? '#F91880' : '#71767B' }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill={selectedPost.liked_by_me ? '#F91880' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                </svg>
              </button>
              {/* Report (with reason) */}
              <button
                onClick={() => openReportModal(selectedPost)}
                className="ios-btn-bounce p-2 transition-colors"
                style={{ color: selectedPost.is_flagged_by_player ? '#F59E0B' : '#71767B' }}
                title="Report post"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill={selectedPost.is_flagged_by_player ? '#F59E0B' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
              </button>
              {/* Dispute with facts */}
              <button
                onClick={() => openDisputeModal(selectedPost)}
                className="ios-btn-bounce p-2 transition-colors hover:text-[#F4212E]"
                style={{ color: '#71767B' }}
                title="Dispute with facts"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </button>
              {/* Share */}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => handleShareMenu(selectedPost.id)}
                  className="ios-btn-bounce p-2 transition-colors hover:text-[#1D9BF0]"
                  style={{ color: '#71767B' }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                </button>
                {shareMenuPostId === selectedPost.id && (
                  <ShareMenu
                    postId={selectedPost.id}
                    sessionId={sessionId!}
                    platform="x_twitter"
                    authorHandle={selectedPost.author_handle}
                    authorDisplayName={selectedPost.author_display_name}
                    contentPreview={selectedPost.content}
                    onClose={() => setShareMenuPostId(null)}
                    onReposted={(repost) => handleReposted(selectedPost.id, repost)}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Replies */}
          {threadReplies.length === 0 ? (
            <div className="flex items-center justify-center h-24">
              <p className="text-[13px]" style={{ color: '#71767B' }}>
                No replies yet
              </p>
            </div>
          ) : (
            threadReplies.map((reply) => {
              const replyBadge = getAuthorBadge(reply.author_type);
              return (
                <div
                  key={reply.id}
                  id={`thread-reply-${reply.id}`}
                  className="px-4 py-3"
                  style={{ borderBottom: '1px solid #2F3336' }}
                >
                  <div className="flex gap-3">
                    {reply.author_type === 'official_account' &&
                    orgPageLogos[reply.author_handle] ? (
                      <img
                        src={orgPageLogos[reply.author_handle]}
                        alt={reply.author_display_name}
                        className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-[14px] flex-shrink-0"
                        style={{ backgroundColor: getAvatarColor(reply.author_display_name) }}
                      >
                        {reply.author_display_name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-bold text-[14px]">{reply.author_display_name}</span>
                        {replyBadge && (
                          <span className="text-[12px]" style={{ color: replyBadge.color }}>
                            {replyBadge.label}
                          </span>
                        )}
                        <span className="text-[13px]" style={{ color: '#71767B' }}>
                          {reply.author_handle}
                        </span>
                        <span className="text-[13px]" style={{ color: '#71767B' }}>
                          · {timeAgo(reply.created_at)}
                        </span>
                      </div>
                      <p className="text-[14px] mt-1 whitespace-pre-wrap">{reply.content}</p>
                      {Array.isArray(reply.media_urls) && reply.media_urls.length > 0 && (
                        <div className="mt-2 rounded-xl">
                          {/\.(mp4|webm|mov)(\?|$)/i.test(reply.media_urls[0]) ? (
                            <video
                              src={reply.media_urls[0]}
                              controls
                              className="w-full rounded-xl"
                              style={{ backgroundColor: '#000' }}
                            />
                          ) : (
                            <img
                              src={reply.media_urls[0]}
                              alt=""
                              className="w-full rounded-xl"
                              style={{ backgroundColor: '#16181C' }}
                            />
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-5 mt-2">
                        <button
                          onClick={() => {
                            setReplyingTo(reply);
                            setComposeText(`${reply.author_handle} `);
                            setComposing(true);
                          }}
                          className="ios-btn-bounce flex items-center gap-1 hover:text-[#1D9BF0] transition-colors"
                          style={{ color: '#71767B' }}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleLike(reply.id)}
                          className="ios-btn-bounce flex items-center gap-1"
                          style={{ color: reply.liked_by_me ? '#F91880' : '#71767B' }}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill={reply.liked_by_me ? '#F91880' : 'none'}
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                          </svg>
                          <span className="text-[12px]">{formatCount(reply.like_count)}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Compose Modal (thread view) */}
        {composing && (
          <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
            <div
              className="flex-1"
              style={{ backgroundColor: 'rgba(91, 112, 131, 0.4)' }}
              onClick={() => {
                setComposing(false);
                setReplyingTo(null);
              }}
            />
            <div
              className="flex flex-col"
              style={{
                backgroundColor: '#000000',
                borderTop: '1px solid #2F3336',
                borderRadius: '16px 16px 0 0',
                maxHeight: '70%',
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid #2F3336' }}
              >
                <button
                  onClick={() => {
                    setComposing(false);
                    setReplyingTo(null);
                  }}
                  className="text-[15px]"
                  style={{ color: '#71767B' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handlePost}
                  disabled={!composeText.trim()}
                  className="px-4 py-1.5 rounded-full text-[15px] font-bold text-white disabled:opacity-40"
                  style={{ backgroundColor: '#1D9BF0' }}
                >
                  Reply
                </button>
              </div>
              {replyingTo && (
                <div className="px-4 pb-2 pt-3">
                  <span className="text-[14px]" style={{ color: '#71767B' }}>
                    Replying to <span style={{ color: '#1D9BF0' }}>{replyingTo.author_handle}</span>
                  </span>
                </div>
              )}
              <div className="flex-1 px-4 pb-2 overflow-y-auto">
                <div className="flex gap-3 pt-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                    style={{ backgroundColor: '#1D9BF0' }}
                  >
                    Y
                  </div>
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
                      placeholder="Post your reply..."
                      className="w-full bg-transparent text-[18px] resize-none outline-none min-h-[100px] placeholder:text-[#71767B]"
                      style={{ color: '#E7E9EA', lineHeight: '1.4' }}
                      maxLength={500}
                      autoFocus
                    />
                    {showMentions && (
                      <div
                        className="absolute left-0 right-0 rounded-lg overflow-hidden z-50"
                        style={{
                          backgroundColor: '#2F3336',
                          maxHeight: 150,
                          overflowY: 'auto',
                          top: 40,
                        }}
                      >
                        {knownHandles
                          .filter((h) => h.handle.toLowerCase().includes(mentionQuery))
                          .slice(0, 6)
                          .map((h) => (
                            <button
                              key={h.handle}
                              onClick={() => {
                                setComposeText((prev) => prev.replace(/@\w*$/, h.handle + ' '));
                                setShowMentions(false);
                              }}
                              className="w-full text-left px-3 py-2 text-[14px] hover:bg-[#1D9BF0]/20"
                              style={{ color: '#E7E9EA' }}
                            >
                              <span style={{ color: '#1D9BF0' }}>{h.handle}</span>
                              <span className="ml-2 text-[12px]" style={{ color: '#71767B' }}>
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
                  style={{ border: '1px solid #2F3336' }}
                >
                  {mediaPreviewUrl.endsWith('.mp4') ? (
                    <video
                      src={mediaPreviewUrl}
                      controls
                      className="w-full max-h-[160px] object-contain"
                      style={{ backgroundColor: '#000' }}
                    />
                  ) : (
                    <img
                      src={mediaPreviewUrl}
                      alt="Media preview"
                      className="w-full max-h-[160px] object-contain"
                      style={{ backgroundColor: '#000' }}
                    />
                  )}
                  <div className="absolute top-2 right-2 flex gap-1">
                    <button
                      onClick={() => setShowMediaPanel(true)}
                      className="px-2 py-1 rounded text-[11px] font-semibold"
                      style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: '#1D9BF0' }}
                    >
                      Change
                    </button>
                    <button
                      onClick={() => {
                        setMediaPreviewUrl(null);
                        setMediaPromptText('');
                      }}
                      className="px-2 py-1 rounded text-[11px] font-semibold"
                      style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: '#ef4444' }}
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
                  style={{ backgroundColor: '#16181C', border: '1px solid #2F3336' }}
                >
                  <div
                    className="flex items-center gap-1 mb-2 rounded-lg overflow-hidden"
                    style={{ backgroundColor: '#000' }}
                  >
                    <button
                      onClick={() => setMediaType('image')}
                      className="flex-1 py-1.5 text-[12px] font-semibold text-center"
                      style={{
                        backgroundColor: mediaType === 'image' ? '#1D9BF0' : 'transparent',
                        color: mediaType === 'image' ? '#fff' : '#71767B',
                      }}
                    >
                      Image
                    </button>
                    <button
                      onClick={() => setMediaType('video')}
                      className="flex-1 py-1.5 text-[12px] font-semibold text-center"
                      style={{
                        backgroundColor: mediaType === 'video' ? '#1D9BF0' : 'transparent',
                        color: mediaType === 'video' ? '#fff' : '#71767B',
                      }}
                    >
                      Video
                    </button>
                  </div>
                  <textarea
                    value={mediaPromptText}
                    onChange={(e) => setMediaPromptText(e.target.value)}
                    placeholder={
                      mediaType === 'video' ? 'Describe your video...' : 'Describe the image...'
                    }
                    className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none"
                    style={{
                      backgroundColor: '#000',
                      color: '#E7E9EA',
                      border: '1px solid #2F3336',
                      minHeight: 40,
                    }}
                    rows={2}
                    maxLength={500}
                  />
                  {mediaGenerating && (
                    <div className="flex items-center gap-2 mt-2">
                      <div
                        className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                        style={{ borderColor: '#1D9BF0', borderTopColor: 'transparent' }}
                      />
                      <span className="text-[11px]" style={{ color: '#71767B' }}>
                        Generating...
                      </span>
                    </div>
                  )}
                  {mediaPreviewUrl && (
                    <div
                      className="mt-2 rounded-lg overflow-hidden"
                      style={{ border: '1px solid #2F3336' }}
                    >
                      {mediaPreviewUrl.endsWith('.mp4') ? (
                        <video
                          src={mediaPreviewUrl}
                          controls
                          className="w-full max-h-[140px] object-contain"
                          style={{ backgroundColor: '#000' }}
                        />
                      ) : (
                        <img
                          src={mediaPreviewUrl}
                          alt="Preview"
                          className="w-full max-h-[140px] object-contain"
                          style={{ backgroundColor: '#000' }}
                        />
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <button
                      onClick={() => setShowMediaPanel(false)}
                      className="text-[11px] font-semibold px-3 py-1 rounded-full"
                      style={{ backgroundColor: '#2F3336', color: '#E7E9EA' }}
                    >
                      Done
                    </button>
                    {!mediaPreviewUrl && !mediaGenerating && (
                      <button
                        disabled={!mediaPromptText.trim()}
                        onClick={handleGeneratePreview}
                        className="text-[11px] font-semibold px-3 py-1 rounded-full disabled:opacity-40"
                        style={{ backgroundColor: '#1D9BF0', color: '#fff' }}
                      >
                        Generate
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Toolbar */}
              <div
                className="flex items-center justify-between px-4 py-2"
                style={{ borderTop: '1px solid #2F3336' }}
              >
                <div className="flex items-center gap-4" style={{ color: '#1D9BF0' }}>
                  <button
                    onClick={() => {
                      setShowMediaPanel(!showMediaPanel);
                      setMediaType('image');
                    }}
                    className="outline-none focus:outline-none hover:opacity-80"
                    title="Attach image"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setShowMediaPanel(!showMediaPanel);
                      setMediaType('video');
                    }}
                    className="outline-none focus:outline-none hover:opacity-80"
                    title="Attach video"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                      <polygon points="10 9 15 12 10 15" />
                    </svg>
                  </button>
                  <button
                    onClick={() => {
                      setShowEmojiPicker(!showEmojiPicker);
                      setShowMediaPanel(false);
                    }}
                    className="outline-none focus:outline-none hover:opacity-80"
                    title="Add emoji"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      <line x1="9" y1="9" x2="9.01" y2="9" />
                      <line x1="15" y1="9" x2="15.01" y2="9" />
                    </svg>
                  </button>
                </div>
                <span className="text-[13px]" style={{ color: '#71767B' }}>
                  {composeText.length}/500
                </span>
              </div>
            </div>
          </div>
        )}

        {disputePost && (
          <DisputeModal
            authorName={disputePost.author_display_name}
            authorHandle={disputePost.author_handle}
            preview={disputePost.content}
            note={disputeNote}
            status={disputeStatus}
            submitting={disputing}
            onNoteChange={setDisputeNote}
            onCancel={() => setDisputePost(null)}
            onSubmit={submitPostDispute}
          />
        )}

        {reportPost && (
          <ReportModal
            authorName={reportPost.author_display_name}
            authorHandle={reportPost.author_handle}
            preview={reportPost.content}
            category={reportCategory}
            reason={reportReason}
            status={reportStatus}
            submitting={reporting}
            onCategoryChange={setReportCategory}
            onReasonChange={setReportReason}
            onCancel={() => setReportPost(null)}
            onSubmit={submitReport}
          />
        )}
      </div>
    );
  }

  if (overlayView === 'page') {
    return (
      <OrgPageView
        platform="x_twitter"
        viewHandle={viewedPageHandle || undefined}
        onBack={() => {
          setViewedPageHandle(null);
          setOverlayView(null);
        }}
      />
    );
  }
  if (overlayView === 'profile') {
    return <PlayerActivityPanel onBack={() => setOverlayView(null)} />;
  }

  return (
    <div
      className="h-full flex flex-col overflow-hidden relative"
      style={{ backgroundColor: '#000000', color: '#E7E9EA', maxWidth: '100%' }}
    >
      {/* Header */}
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid #2F3336' }}>
        <div className="flex items-center pl-12 pr-4" style={{ height: 53, gap: 12 }}>
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowAvatarMenu(!showAvatarMenu)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[12px]"
              style={{ backgroundColor: '#1D9BF0' }}
            >
              Y
            </button>
            {showAvatarMenu && (
              <div
                className="absolute top-10 left-0 rounded-lg overflow-hidden z-50"
                style={{ backgroundColor: '#16181C', border: '1px solid #2F3336', width: 180 }}
              >
                {orgPageInfo && (
                  <button
                    onClick={() => {
                      setViewedPageHandle(null);
                      setOverlayView('page');
                      setShowAvatarMenu(false);
                    }}
                    className="w-full text-left px-3 py-2.5 text-[13px] hover:bg-white/5"
                    style={{ color: '#E7E9EA', borderBottom: '1px solid #2F3336' }}
                  >
                    {orgPageInfo.page_name}
                  </button>
                )}
                <button
                  onClick={() => {
                    setOverlayView('profile');
                    setShowAvatarMenu(false);
                  }}
                  className="w-full text-left px-3 py-2.5 text-[13px] hover:bg-white/5"
                  style={{ color: '#E7E9EA', borderBottom: '1px solid #2F3336' }}
                >
                  My Activity
                </button>
                <button
                  onClick={() => {
                    navigate(`/sim/${sessionId}/device/home`);
                    setShowAvatarMenu(false);
                  }}
                  className="w-full text-left px-3 py-2.5 text-[13px] hover:bg-white/5"
                  style={{ color: '#71767B' }}
                >
                  Back to Home
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 flex justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 4H20L4 20H20"
                stroke="#E7E9EA"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <button
            onClick={() => {
              setShowNotifPanel(!showNotifPanel);
              if (!showNotifPanel) fetchNotifications();
            }}
            className="ios-btn-bounce w-8 h-8 flex items-center justify-center flex-shrink-0 relative"
          >
            <span className="text-[20px] leading-none" style={{ color: '#FFFFFF' }}>
              &#x1F514;
            </span>
            {notifCount > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white px-1"
                style={{ backgroundColor: '#1D9BF0' }}
              >
                {notifCount > 99 ? '99+' : notifCount}
              </span>
            )}
          </button>
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/facebook`)}
            className="ios-btn-bounce w-8 h-8 flex items-center justify-center rounded-full flex-shrink-0"
            style={{ backgroundColor: '#1877F2' }}
            title="Switch to Fakebook"
          >
            <span className="text-white text-[11px] font-black tracking-tight">fk</span>
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex">
          <button
            onClick={() => setActiveTab('foryou')}
            className="flex-1 py-3 text-center text-[15px] font-bold relative transition-colors"
            style={{ color: activeTab === 'foryou' ? '#E7E9EA' : '#71767B' }}
          >
            For You
            {activeTab === 'foryou' && (
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-14 rounded-full"
                style={{ backgroundColor: '#1D9BF0' }}
              />
            )}
          </button>
          <button
            onClick={() => setActiveTab('latest')}
            className="flex-1 py-3 text-center text-[15px] font-bold relative transition-colors"
            style={{ color: activeTab === 'latest' ? '#E7E9EA' : '#71767B' }}
          >
            Latest
            {activeTab === 'latest' && (
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-14 rounded-full"
                style={{ backgroundColor: '#1D9BF0' }}
              />
            )}
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div
        className="flex-shrink-0 px-4 py-2 relative"
        style={{ borderBottom: '1px solid #2F3336', zIndex: 30 }}
      >
        <div
          className="flex items-center rounded-full px-3 py-1.5"
          style={{ backgroundColor: '#16181C', border: '1px solid #2F3336' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" stroke="#71767B" strokeWidth="2" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#71767B" strokeWidth="2" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search posts, #hashtags, @users..."
            className="flex-1 bg-transparent outline-none text-[13px] ml-2"
            style={{ color: '#E7E9EA' }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-[14px] ml-1"
              style={{ color: '#71767B' }}
            >
              ✕
            </button>
          )}
        </div>
        {/* Search suggestions */}
        {(searchQuery || '').length >= 1 &&
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
            const handleMatches = allHandles.filter((h) => h.toLowerCase().includes(q)).slice(0, 3);
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
                className="absolute left-4 right-4 top-full mt-1 rounded-lg overflow-hidden z-50"
                style={{
                  backgroundColor: '#16181C',
                  border: '1px solid #2F3336',
                  maxHeight: 200,
                  overflowY: 'auto',
                }}
              >
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSearchQuery(s.value);
                    }}
                    className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-white/[0.05] transition-colors"
                  >
                    {s.type === 'hashtag' ? (
                      <span className="text-[13px] font-bold" style={{ color: '#1D9BF0' }}>
                        #
                      </span>
                    ) : (
                      <span className="text-[13px] font-bold" style={{ color: '#1D9BF0' }}>
                        @
                      </span>
                    )}
                    <span className="text-[13px]" style={{ color: '#E7E9EA' }}>
                      {s.value}
                    </span>
                    {s.type === 'user' && s.name && (
                      <span className="text-[12px] ml-1" style={{ color: '#71767B' }}>
                        {s.name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })()}
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div
              className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#1D9BF0', borderTopColor: 'transparent' }}
            />
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 px-8 text-center">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#333639"
              strokeWidth="1.5"
            >
              <path
                d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="text-[15px] font-bold" style={{ color: '#E7E9EA' }}>
              Welcome to X
            </p>
            <p className="text-[13px]" style={{ color: '#71767B' }}>
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
              if (activeTab === 'latest') {
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              }
              const aIsPlayer = a.author_type === 'player';
              const bIsPlayer = b.author_type === 'player';
              if (aIsPlayer && !bIsPlayer) return -1;
              if (!aIsPlayer && bIsPlayer) return 1;
              if (aIsPlayer && bIsPlayer) {
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              }
              const recencyA = Math.max(
                0,
                1 - (Date.now() - new Date(a.created_at).getTime()) / (45 * 60000),
              );
              const recencyB = Math.max(
                0,
                1 - (Date.now() - new Date(b.created_at).getTime()) / (45 * 60000),
              );
              const scoreA = (a.virality_score || 0) * 0.6 + recencyA * 100 * 0.4;
              const scoreB = (b.virality_score || 0) * 0.6 + recencyB * 100 * 0.4;
              return scoreB - scoreA;
            })
            .map((post) => {
              const badge = getAuthorBadge(post.author_type);
              return (
                <div
                  key={post.id}
                  className="px-4 py-3 transition-colors cursor-pointer hover:bg-white/[0.03]"
                  style={{
                    borderBottom: '1px solid #2F3336',
                    borderLeft: isTrainer ? getSentimentBorder(post.sentiment) : undefined,
                  }}
                  onClick={() => openThread(post)}
                >
                  {isTrainer && post.requires_response && !post.responded_at && (
                    <div className="flex items-center gap-1.5 mb-2 ml-[52px]">
                      <span className="relative flex h-2 w-2">
                        <span
                          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                          style={{ backgroundColor: '#F59E0B' }}
                        />
                        <span
                          className="relative inline-flex rounded-full h-2 w-2"
                          style={{ backgroundColor: '#F59E0B' }}
                        />
                      </span>
                      <span
                        className="text-[12px] font-bold tracking-wide"
                        style={{ color: '#F59E0B' }}
                      >
                        REQUIRES RESPONSE
                      </span>
                    </div>
                  )}

                  <div className="flex gap-3">
                    {post.author_type === 'official_account' && orgPageLogos[post.author_handle] ? (
                      <img
                        src={orgPageLogos[post.author_handle]}
                        alt={post.author_display_name}
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewedPageHandle(post.author_handle);
                          setOverlayView('page');
                        }}
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                        style={{
                          backgroundColor: getAvatarColor(post.author_display_name),
                          cursor: post.author_type === 'official_account' ? 'pointer' : undefined,
                        }}
                        onClick={
                          post.author_type === 'official_account'
                            ? (e) => {
                                e.stopPropagation();
                                setViewedPageHandle(post.author_handle);
                                setOverlayView('page');
                              }
                            : undefined
                        }
                      >
                        {post.author_display_name.charAt(0).toUpperCase()}
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className="font-bold text-[15px] truncate"
                          style={{ color: '#E7E9EA' }}
                        >
                          {post.author_display_name}
                        </span>
                        {badge && (
                          <span
                            className="text-[12px] flex-shrink-0"
                            style={{ color: badge.color }}
                          >
                            {badge.label}
                          </span>
                        )}
                        <span className="text-[15px] truncate" style={{ color: '#71767B' }}>
                          {post.author_handle}
                        </span>
                        <span style={{ color: '#71767B' }}>·</span>
                        <span className="text-[14px] flex-shrink-0" style={{ color: '#71767B' }}>
                          {timeAgo(post.created_at)}
                        </span>
                        {post.is_surfaced_to_session && (
                          <span
                            className="text-[10px] font-bold flex-shrink-0 px-1.5 py-0.5 rounded"
                            style={{ color: '#8FB6FF', backgroundColor: 'rgba(76,141,255,0.15)' }}
                          >
                            Surfaced by teammate
                          </span>
                        )}
                      </div>
                      {post.author_type === 'official_account' && post.posted_by_display_name && (
                        <div className="text-[11px] mt-0.5" style={{ color: '#71767B' }}>
                          Posted by {post.posted_by_display_name}
                        </div>
                      )}

                      {post.is_repost && (
                        <div
                          className="flex items-center gap-1 mt-0.5"
                          style={{ color: '#71767B' }}
                        >
                          <svg
                            width="12"
                            height="12"
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
                          <span className="text-[12px]">Reposted</span>
                        </div>
                      )}

                      {post.post_format && FORMAT_BADGE[post.post_format] && (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-sm font-semibold inline-block mt-1"
                          style={{
                            backgroundColor: FORMAT_BADGE[post.post_format].bg,
                            color: FORMAT_BADGE[post.post_format].fg,
                          }}
                        >
                          {FORMAT_BADGE[post.post_format].label}
                        </span>
                      )}

                      <p
                        className="text-[15px] mt-1 whitespace-pre-wrap break-words"
                        style={{ color: '#E7E9EA', lineHeight: '1.4' }}
                      >
                        {String(post.content)
                          .split(/(#\w+)/g)
                          .map((part: string, i: number) =>
                            part.startsWith('#') ? (
                              <span
                                key={i}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSearchQuery(part);
                                }}
                                className="cursor-pointer hover:underline"
                                style={{ color: '#1D9BF0' }}
                              >
                                {part}
                              </span>
                            ) : (
                              <span key={i}>{part}</span>
                            ),
                          )}
                      </p>

                      {Array.isArray(post.media_urls) && post.media_urls.length > 0 && (
                        <div className="mt-2 relative rounded-xl">
                          {/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0]) ? (
                            <video
                              src={post.media_urls[0]}
                              controls
                              className="w-full rounded-xl"
                              style={{ backgroundColor: '#000' }}
                            />
                          ) : (
                            <img
                              src={post.media_urls[0]}
                              alt=""
                              className="w-full rounded-xl"
                              style={{ backgroundColor: '#16181C' }}
                            />
                          )}
                          {post.post_format === 'video_concept' &&
                            !/\.(mp4|webm|mov)(\?|$)/i.test(post.media_urls[0] || '') && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <div
                                  className="w-14 h-14 rounded-full flex items-center justify-center"
                                  style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
                                >
                                  <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                                    <polygon points="8,5 19,12 8,19" />
                                  </svg>
                                </div>
                              </div>
                            )}
                        </div>
                      )}

                      {/* Link preview card for shared articles */}
                      {(() => {
                        const sa = (post.content_flags as Record<string, unknown>)
                          ?.shared_article as Record<string, unknown> | undefined;
                        if (!sa) return null;
                        return (
                          <LinkPreviewCard
                            headline={String(sa.headline || '')}
                            outletName={String(sa.outlet_name || '')}
                            snippet={String(sa.snippet || '')}
                            category={String(sa.category || '')}
                            platform="x_twitter"
                            onClick={() =>
                              navigate(`/sim/${sessionId}/device/news?article=${sa.id}`)
                            }
                          />
                        );
                      })()}

                      {isTrainer &&
                        !!(
                          post.content_flags &&
                          (post.content_flags.is_hate_speech ||
                            post.content_flags.is_harmful_narrative ||
                            post.content_flags.is_misinformation ||
                            post.content_flags.is_inflammatory ||
                            post.content_flags.incites_violence ||
                            post.content_flags.is_organized_pressure)
                        ) && (
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            {!!post.content_flags.is_hate_speech && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(239,68,68,0.15)',
                                  color: '#F87171',
                                }}
                              >
                                Hate Speech
                              </span>
                            )}
                            {!!post.content_flags.is_harmful_narrative &&
                              !post.content_flags.is_hate_speech && (
                                <span
                                  className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                  style={{
                                    backgroundColor: 'rgba(239,68,68,0.15)',
                                    color: '#F87171',
                                  }}
                                >
                                  Harmful
                                </span>
                              )}
                            {!!post.content_flags.is_misinformation && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(249,115,22,0.15)',
                                  color: '#FB923C',
                                }}
                              >
                                Misinformation
                              </span>
                            )}
                            {!!post.content_flags.is_inflammatory && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(249,115,22,0.15)',
                                  color: '#FB923C',
                                }}
                              >
                                Inflammatory
                              </span>
                            )}
                            {!!post.content_flags.incites_violence && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(239,68,68,0.15)',
                                  color: '#F87171',
                                }}
                              >
                                Threat
                              </span>
                            )}
                            {!!post.content_flags.is_organized_pressure && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(249,115,22,0.15)',
                                  color: '#FB923C',
                                }}
                              >
                                Pressure Campaign
                              </span>
                            )}
                            {!!post.content_flags.is_racist && (
                              <span
                                className="text-[11px] px-2 py-0.5 rounded-sm font-semibold"
                                style={{
                                  backgroundColor: 'rgba(239,68,68,0.15)',
                                  color: '#F87171',
                                }}
                              >
                                Racist Content
                              </span>
                            )}
                          </div>
                        )}
                    </div>
                  </div>

                  {/* Engagement bar */}
                  <div
                    className="flex items-center justify-evenly mt-2 -mx-2"
                    style={{ color: '#71767B' }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setReplyingTo(post);
                        setComposing(true);
                      }}
                      className="flex items-center gap-1 group transition-colors hover:text-[#1D9BF0]"
                    >
                      <div className="p-1 rounded-full group-hover:bg-[#1D9BF0]/10 transition-colors">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                        </svg>
                      </div>
                      <span className="text-[11px]">
                        {post.reply_count > 0 ? formatCount(post.reply_count) : ''}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRepost(post.id);
                      }}
                      className="flex items-center gap-1 group transition-colors hover:text-[#00BA7C]"
                    >
                      <div className="p-1 rounded-full group-hover:bg-[#00BA7C]/10 transition-colors">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M17 1l4 4-4 4" />
                          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                          <path d="M7 23l-4-4 4-4" />
                          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                        </svg>
                      </div>
                      <span className="text-[11px]">
                        {post.repost_count > 0 ? formatCount(post.repost_count) : ''}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLike(post.id);
                      }}
                      className={`flex items-center gap-1 group transition-colors ${post.liked_by_me ? 'text-[#F91880]' : 'hover:text-[#F91880]'}`}
                    >
                      <div className="p-1 rounded-full group-hover:bg-[#F91880]/10 transition-colors">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill={post.liked_by_me ? '#F91880' : 'none'}
                          stroke={post.liked_by_me ? '#F91880' : 'currentColor'}
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                      </div>
                      <span className="text-[11px]">
                        {post.like_count > 0 ? formatCount(post.like_count) : ''}
                      </span>
                    </button>
                    <div className="flex items-center gap-1">
                      <div className="p-1">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M18 20V10M12 20V4M6 20v-6" />
                        </svg>
                      </div>
                      <span className="text-[11px]">
                        {post.view_count > 0 ? formatCount(post.view_count) : ''}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleFlag(post.id);
                      }}
                      className={`flex items-center group transition-colors ${post.flagged_by_me ? 'text-[#F59E0B]' : 'hover:text-[#F59E0B]'}`}
                    >
                      <div className="p-1 rounded-full group-hover:bg-[#F59E0B]/10 transition-colors">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill={post.flagged_by_me ? '#F59E0B' : 'none'}
                          stroke={post.flagged_by_me ? '#F59E0B' : 'currentColor'}
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                          <line x1="4" y1="22" x2="4" y2="15" />
                        </svg>
                      </div>
                    </button>
                    <div style={{ position: 'relative' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleShareMenu(post.id);
                        }}
                        className="flex items-center group transition-colors hover:text-[#1D9BF0]"
                      >
                        <div className="p-1 rounded-full group-hover:bg-[#1D9BF0]/10 transition-colors">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                            <polyline points="16 6 12 2 8 6" />
                            <line x1="12" y1="2" x2="12" y2="15" />
                          </svg>
                        </div>
                      </button>
                      {shareMenuPostId === post.id && (
                        <ShareMenu
                          postId={post.id}
                          sessionId={sessionId!}
                          platform="x_twitter"
                          authorHandle={post.author_handle}
                          authorDisplayName={post.author_display_name}
                          contentPreview={post.content}
                          onClose={() => setShareMenuPostId(null)}
                          onReposted={(repost) => handleReposted(post.id, repost)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })
        )}
      </div>

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
              top: 53,
              zIndex: 45,
              maxHeight: '70%',
              backgroundColor: '#000',
              borderBottom: '2px solid #2F3336',
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderBottom: '1px solid #2F3336' }}
            >
              <span className="text-[16px] font-bold" style={{ color: '#E7E9EA' }}>
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
                  className="text-[13px] font-semibold"
                  style={{ color: '#1D9BF0' }}
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
              const inPageMode = overlayView === 'page';
              const socialNotifs = notifications.filter(
                (n) =>
                  socialTypes.includes(n.type) &&
                  (!n.metadata?.platform || n.metadata.platform === 'x_twitter') &&
                  (!inPageMode || n.metadata?.is_page_notification === true),
              );
              return socialNotifs.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-[14px]" style={{ color: '#71767B' }}>
                    No notifications yet
                  </span>
                </div>
              ) : (
                socialNotifs.map((notif) => (
                  <button
                    key={notif.id}
                    onClick={async () => {
                      if (!notif.read) markNotifRead(notif.id);
                      setShowNotifPanel(false);
                      const postId = notif.metadata?.post_id as string | undefined;
                      const highlightId = notif.metadata?.highlight_post_id as string | undefined;
                      if (postId) {
                        const targetPost = posts.find((p) => p.id === postId);
                        if (targetPost) {
                          openThread(targetPost, highlightId);
                        } else {
                          try {
                            const headers = await getAuthHeaders();
                            const res = await fetch(apiUrl(`/api/social/posts/${postId}`), {
                              headers,
                            });
                            const result = await res.json();
                            if (result.data) {
                              openThread(result.data as SocialPost, highlightId);
                            }
                          } catch {
                            /* ignore */
                          }
                        }
                      }
                    }}
                    className="flex items-start gap-3 w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors"
                    style={{
                      borderBottom: '1px solid #2F3336',
                      backgroundColor: notif.read ? 'transparent' : 'rgba(29,155,240,0.05)',
                    }}
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ backgroundColor: '#16181C' }}
                    >
                      {notif.type === 'social_like' ? (
                        <span className="text-[15px] leading-none">
                          {REACTION_EMOJI[String(notif.metadata?.reaction_type || 'like')] ||
                            '\u{1F44D}'}
                        </span>
                      ) : notif.type === 'social_reply' ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
                            stroke="#1D9BF0"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : notif.type === 'social_mention' ? (
                        <span className="text-[14px] font-bold" style={{ color: '#1D9BF0' }}>
                          @
                        </span>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M17 1l4 4-4 4"
                            stroke="#00BA7C"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M3 11V9a4 4 0 0 1 4-4h14"
                            stroke="#00BA7C"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M7 23l-4-4 4-4"
                            stroke="#00BA7C"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M21 13v2a4 4 0 0 1-4 4H3"
                            stroke="#00BA7C"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px]" style={{ color: '#E7E9EA' }}>
                        {notif.title}
                      </p>
                      {notif.message && (
                        <p className="text-[13px] mt-0.5 truncate" style={{ color: '#71767B' }}>
                          {notif.message}
                        </p>
                      )}
                      <span className="text-[12px] mt-0.5 block" style={{ color: '#71767B' }}>
                        {timeAgo(notif.created_at)}
                      </span>
                    </div>
                    {!notif.read && (
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0 mt-2"
                        style={{ backgroundColor: '#1D9BF0' }}
                      />
                    )}
                  </button>
                ))
              );
            })()}
          </div>
        </>
      )}

      {/* Compose FAB */}
      {!composing && (
        <button
          onClick={() => setComposing(true)}
          className="absolute ios-btn-bounce flex items-center justify-center"
          style={{
            bottom: 24,
            right: 20,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#1D9BF0',
            boxShadow: '0 4px 12px rgba(29,155,240,0.4)',
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {/* Compose Modal */}
      {composing && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 60 }}>
          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(91, 112, 131, 0.4)' }}
            onClick={() => {
              setComposing(false);
              setReplyingTo(null);
            }}
          />
          <div
            className="flex flex-col"
            style={{
              backgroundColor: '#000000',
              borderTop: '1px solid #2F3336',
              borderRadius: '16px 16px 0 0',
              maxHeight: '70%',
              minHeight: 280,
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderBottom: '1px solid #2F3336' }}
            >
              <button
                onClick={() => {
                  setComposing(false);
                  setReplyingTo(null);
                }}
                className="text-[15px]"
                style={{ color: '#E7E9EA' }}
              >
                Cancel
              </button>
              <button
                onClick={handlePost}
                disabled={!composeText.trim()}
                className="px-4 py-1.5 rounded-full text-[15px] font-bold text-white disabled:opacity-40"
                style={{ backgroundColor: '#1D9BF0' }}
              >
                Post
              </button>
            </div>

            {replyingTo && (
              <div className="px-4 pb-2 pt-3">
                <span className="text-[14px]" style={{ color: '#71767B' }}>
                  Replying to <span style={{ color: '#1D9BF0' }}>{replyingTo.author_handle}</span>
                </span>
              </div>
            )}

            {!replyingTo && (
              <div className="px-4 pt-3 pb-1 flex gap-1.5 flex-wrap">
                {POST_FORMATS.map((fmt) => (
                  <button
                    key={fmt.value}
                    onClick={() => setSelectedFormat(fmt.value)}
                    className="px-2.5 py-1 rounded-full text-[12px] font-semibold transition-colors"
                    style={{
                      backgroundColor: selectedFormat === fmt.value ? '#1D9BF0' : '#2F3336',
                      color: selectedFormat === fmt.value ? '#FFFFFF' : '#71767B',
                    }}
                  >
                    {fmt.icon} {fmt.label}
                  </button>
                ))}
              </div>
            )}

            {orgPageInfo && !replyingTo && (
              <div
                className="px-4 py-2 flex items-center gap-2"
                style={{ borderBottom: '1px solid #2F3336' }}
              >
                <span className="text-[12px]" style={{ color: '#71767B' }}>
                  Posting as:
                </span>
                <button
                  onClick={() => setPostingAsPage(false)}
                  className="px-2.5 py-1 rounded-full text-[12px] font-semibold"
                  style={{
                    backgroundColor: !postingAsPage ? '#1D9BF0' : 'transparent',
                    color: !postingAsPage ? '#fff' : '#71767B',
                    border: !postingAsPage ? '1px solid #1D9BF0' : '1px solid #333639',
                  }}
                >
                  You
                </button>
                <button
                  onClick={() => setPostingAsPage(true)}
                  className="px-2.5 py-1 rounded-full text-[12px] font-semibold"
                  style={{
                    backgroundColor: postingAsPage ? '#1D9BF0' : 'transparent',
                    color: postingAsPage ? '#fff' : '#71767B',
                    border: postingAsPage ? '1px solid #1D9BF0' : '1px solid #333639',
                  }}
                >
                  {orgPageInfo.page_name}
                </button>
              </div>
            )}

            <div className="flex-1 px-4 pb-2 overflow-y-auto">
              <div className="flex gap-3 pt-3">
                {postingAsPage && orgPageInfo?.page_logo_url ? (
                  <img
                    src={orgPageInfo.page_logo_url}
                    alt={orgPageInfo.page_name}
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                  />
                ) : (
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[16px] flex-shrink-0"
                    style={{ backgroundColor: '#1D9BF0' }}
                  >
                    {postingAsPage
                      ? orgPageInfo?.page_name?.[0] || 'O'
                      : playerDisplayName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 relative">
                  <textarea
                    ref={composeRef}
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
                    placeholder={
                      replyingTo
                        ? 'Post your reply...'
                        : POST_FORMATS.find((f) => f.value === selectedFormat)?.placeholder ||
                          "What's happening?"
                    }
                    className="flex-1 bg-transparent text-[18px] resize-none outline-none min-h-[120px] placeholder:text-[#71767B]"
                    style={{ color: '#E7E9EA', lineHeight: '1.4' }}
                    maxLength={500}
                    autoFocus
                  />
                  {showMentions && (
                    <div
                      className="absolute left-0 right-0 rounded-lg overflow-hidden z-50"
                      style={{
                        backgroundColor: '#2F3336',
                        maxHeight: 150,
                        overflowY: 'auto',
                        top: 40,
                      }}
                    >
                      {knownHandles
                        .filter((h) => h.handle.toLowerCase().includes(mentionQuery))
                        .slice(0, 6)
                        .map((h) => (
                          <button
                            key={h.handle}
                            onClick={() => {
                              setComposeText((prev) => prev.replace(/@\w*$/, h.handle + ' '));
                              setShowMentions(false);
                            }}
                            className="w-full text-left px-3 py-2 text-[14px] hover:bg-[#1D9BF0]/20"
                            style={{ color: '#E7E9EA' }}
                          >
                            <span style={{ color: '#1D9BF0' }}>{h.handle}</span>
                            <span className="ml-2 text-[12px]" style={{ color: '#71767B' }}>
                              {h.display_name}
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Media preview (confirmed) */}
            {mediaPreviewUrl && !showMediaPanel && (
              <div
                className="mx-4 mb-2 rounded-xl overflow-hidden relative"
                style={{ border: '1px solid #2F3336' }}
              >
                {mediaPreviewUrl.endsWith('.mp4') ? (
                  <video
                    src={mediaPreviewUrl}
                    controls
                    className="w-full max-h-[200px] object-contain"
                    style={{ backgroundColor: '#000' }}
                  />
                ) : (
                  <img
                    src={mediaPreviewUrl}
                    alt="Media preview"
                    className="w-full max-h-[200px] object-contain"
                    style={{ backgroundColor: '#000' }}
                  />
                )}
                <div className="absolute top-2 right-2 flex gap-1">
                  <button
                    onClick={() => setShowMediaPanel(true)}
                    className="px-2 py-1 rounded text-[11px] font-semibold outline-none focus:outline-none"
                    style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: '#1D9BF0' }}
                  >
                    Change
                  </button>
                  <button
                    onClick={() => {
                      setMediaPreviewUrl(null);
                      setMediaPromptText('');
                    }}
                    className="px-2 py-1 rounded text-[11px] font-semibold outline-none focus:outline-none"
                    style={{ backgroundColor: 'rgba(0,0,0,0.7)', color: '#ef4444' }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}

            {/* Unified media panel */}
            {showMediaPanel && (
              <div
                className="mx-4 mb-2 rounded-xl p-3"
                style={{ backgroundColor: '#16181C', border: '1px solid #2F3336' }}
              >
                {/* Type toggle */}
                <div
                  className="flex items-center gap-1 mb-3 rounded-lg overflow-hidden"
                  style={{ backgroundColor: '#000' }}
                >
                  <button
                    onClick={() => setMediaType('image')}
                    className="flex-1 py-2 text-[13px] font-semibold text-center outline-none focus:outline-none transition-colors"
                    style={{
                      backgroundColor: mediaType === 'image' ? '#1D9BF0' : 'transparent',
                      color: mediaType === 'image' ? '#fff' : '#71767B',
                    }}
                  >
                    Image
                  </button>
                  <button
                    onClick={() => setMediaType('video')}
                    className="flex-1 py-2 text-[13px] font-semibold text-center outline-none focus:outline-none transition-colors"
                    style={{
                      backgroundColor: mediaType === 'video' ? '#1D9BF0' : 'transparent',
                      color: mediaType === 'video' ? '#fff' : '#71767B',
                    }}
                  >
                    Video
                  </button>
                </div>

                {/* Prompt */}
                <textarea
                  autoFocus
                  value={mediaPromptText}
                  onChange={(e) => setMediaPromptText(e.target.value)}
                  placeholder={
                    mediaType === 'video'
                      ? 'Describe your video concept... e.g. A 10-second clip of community members cleaning up the mosque, showing solidarity'
                      : 'Describe the image... e.g. An infographic showing verified facts about the incident'
                  }
                  className="w-full rounded-lg px-3 py-2 text-[14px] outline-none resize-none"
                  style={{
                    backgroundColor: '#000',
                    color: '#E7E9EA',
                    border: '1px solid #2F3336',
                    minHeight: 50,
                  }}
                  rows={2}
                  maxLength={500}
                />

                {/* Video options */}
                {mediaType === 'video' && (
                  <div className="mt-2 flex gap-3">
                    {/* Duration */}
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px]" style={{ color: '#94a3b8' }}>
                          Duration
                        </span>
                        <span className="text-[11px] font-bold" style={{ color: '#1D9BF0' }}>
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
                        className="w-full accent-[#1D9BF0]"
                        style={{ height: 4 }}
                      />
                      <div
                        className="flex justify-between text-[10px] mt-0.5"
                        style={{ color: '#475569' }}
                      >
                        <span>5s</span>
                        <span>10s</span>
                        <span>15s</span>
                      </div>
                    </div>
                    {/* Orientation */}
                    <div>
                      <span className="text-[11px] block mb-1" style={{ color: '#94a3b8' }}>
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
                            className="px-2 py-1.5 rounded text-[10px] font-semibold outline-none focus:outline-none transition-colors"
                            style={{
                              backgroundColor: videoOrientation === ratio ? '#1D9BF0' : '#2F3336',
                              color: videoOrientation === ratio ? '#fff' : '#71767B',
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Generate / Loading */}
                {mediaGenerating && (
                  <div className="flex items-center gap-2 mt-2 px-1">
                    <div
                      className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                      style={{ borderColor: '#1D9BF0', borderTopColor: 'transparent' }}
                    />
                    <span className="text-[12px]" style={{ color: '#71767B' }}>
                      {mediaType === 'video'
                        ? 'Generating video (this may take a minute)...'
                        : 'Generating image...'}
                    </span>
                  </div>
                )}

                {/* Preview inline */}
                {mediaPreviewUrl && !mediaGenerating && (
                  <div
                    className="mt-2 rounded-lg overflow-hidden"
                    style={{ border: '1px solid #2F3336' }}
                  >
                    {mediaPreviewUrl.endsWith('.mp4') ? (
                      <video
                        src={mediaPreviewUrl}
                        controls
                        className="w-full max-h-[180px] object-contain"
                        style={{ backgroundColor: '#000' }}
                      />
                    ) : (
                      <img
                        src={mediaPreviewUrl}
                        alt="Preview"
                        className="w-full max-h-[180px] object-contain"
                        style={{ backgroundColor: '#000' }}
                      />
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px]" style={{ color: '#71767B' }}>
                    {mediaType === 'video'
                      ? 'AI generates a 10s video clip'
                      : 'AI generates and grades the media concept'}
                  </span>
                  <div className="flex gap-2">
                    {mediaPreviewUrl && !mediaGenerating && (
                      <>
                        <button
                          onClick={() => {
                            setMediaPreviewUrl(null);
                            handleGeneratePreview();
                          }}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-full outline-none focus:outline-none"
                          style={{ backgroundColor: '#2F3336', color: '#E7E9EA' }}
                        >
                          Regenerate
                        </button>
                        <button
                          onClick={() => setShowMediaPanel(false)}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-full outline-none focus:outline-none"
                          style={{ backgroundColor: '#1D9BF0', color: '#fff' }}
                        >
                          Use This
                        </button>
                      </>
                    )}
                    {!mediaPreviewUrl && !mediaGenerating && (
                      <button
                        onClick={handleGeneratePreview}
                        disabled={!mediaPromptText.trim()}
                        className="text-[12px] font-semibold px-3 py-1.5 rounded-full outline-none focus:outline-none disabled:opacity-40"
                        style={{ backgroundColor: '#1D9BF0', color: '#fff' }}
                      >
                        Generate Preview
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Emoji picker */}
            {showEmojiPicker && (
              <div
                className="mx-4 mb-2 rounded-xl p-3 grid grid-cols-8 gap-1"
                style={{ backgroundColor: '#16181C', border: '1px solid #2F3336' }}
              >
                {[
                  '😀',
                  '😂',
                  '🥺',
                  '😢',
                  '😡',
                  '🤔',
                  '👍',
                  '👎',
                  '❤️',
                  '🙏',
                  '💪',
                  '🔥',
                  '⚠️',
                  '✅',
                  '❌',
                  '📢',
                  '🕊️',
                  '🤝',
                  '😤',
                  '💔',
                  '🫡',
                  '📸',
                  '🎥',
                  '📊',
                ].map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      const ta = composeRef.current;
                      if (ta) {
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        const newText =
                          composeText.slice(0, start) + emoji + composeText.slice(end);
                        setComposeText(newText);
                        setTimeout(() => {
                          ta.focus();
                          ta.setSelectionRange(start + emoji.length, start + emoji.length);
                        }, 0);
                      } else {
                        setComposeText((prev) => prev + emoji);
                      }
                      setShowEmojiPicker(false);
                    }}
                    className="text-[22px] p-1.5 rounded-lg hover:bg-white/10 transition-colors outline-none focus:outline-none"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}

            <div
              className="flex items-center justify-between px-4 py-2.5"
              style={{ borderTop: '1px solid #2F3336' }}
            >
              <div className="flex items-center gap-4" style={{ color: '#1D9BF0' }}>
                <button
                  onClick={() => {
                    setShowMediaPanel(!showMediaPanel);
                    setMediaType('image');
                    setShowEmojiPicker(false);
                  }}
                  className="outline-none focus:outline-none hover:opacity-80 transition-opacity"
                  style={{ color: mediaPreviewUrl ? '#1D9BF0' : undefined }}
                  title="Attach image"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    setShowMediaPanel(!showMediaPanel);
                    setMediaType('video');
                    setShowEmojiPicker(false);
                  }}
                  className="outline-none focus:outline-none hover:opacity-80 transition-opacity"
                  title="Attach video"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                    <polygon points="10 9 15 12 10 15" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    setShowEmojiPicker(!showEmojiPicker);
                    setShowMediaPanel(false);
                  }}
                  className="outline-none focus:outline-none hover:opacity-80 transition-opacity"
                  title="Add emoji"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" />
                    <line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px]" style={{ color: '#71767B' }}>
                  {composeText.length}/500
                </span>
                {composeText.length > 0 && (
                  <svg width="20" height="20" viewBox="0 0 20 20">
                    <circle cx="10" cy="10" r="9" fill="none" stroke="#2F3336" strokeWidth="2" />
                    <circle
                      cx="10"
                      cy="10"
                      r="9"
                      fill="none"
                      strokeWidth="2"
                      stroke={composeText.length > 450 ? '#F4212E' : '#1D9BF0'}
                      strokeDasharray={`${(composeText.length / 500) * 56.5} 56.5`}
                      strokeLinecap="round"
                      transform="rotate(-90 10 10)"
                    />
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
