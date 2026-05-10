import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';

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

function getAvatarColor(name: string): string {
  const colors = ['#1877F2', '#42B72A', '#F02849', '#FF6D00', '#8B5CF6', '#0EA5E9'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
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

const GROUP_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  community: { bg: '#E3F2FD', fg: '#1565C0' },
  activism: { bg: '#FCE4EC', fg: '#C62828' },
  news: { bg: '#FFF3E0', fg: '#E65100' },
  support: { bg: '#E8F5E9', fg: '#2E7D32' },
  humor: { bg: '#F3E5F5', fg: '#6A1B9A' },
  politics: { bg: '#EDE7F6', fg: '#4527A0' },
  education: { bg: '#E0F7FA', fg: '#00695C' },
  local: { bg: '#FFF8E1', fg: '#F57F17' },
};

function getGroupTypeStyle(type: string): { bg: string; fg: string } {
  return GROUP_TYPE_COLORS[type.toLowerCase()] || { bg: '#F0F2F5', fg: '#65676B' };
}

interface Group {
  id: string;
  name: string;
  description?: string;
  group_type?: string;
  member_count: number;
  cover_image_url?: string;
}

interface GroupPost {
  id: string;
  author_display_name: string;
  author_handle: string;
  content: string;
  like_count: number;
  reply_count: number;
  created_at: string;
  reply_to_post_id?: string | null;
  liked_by_me?: boolean;
  replies?: GroupPost[];
}

interface FacebookGroupsViewProps {
  sessionId: string;
}

const COVER_COLORS = [
  '#1877F2',
  '#42B72A',
  '#F02849',
  '#FF6D00',
  '#8B5CF6',
  '#0EA5E9',
  '#E91E63',
  '#009688',
];

function getCoverColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COVER_COLORS[Math.abs(hash) % COVER_COLORS.length];
}

export default function FacebookGroupsView({ sessionId }: FacebookGroupsViewProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [groupPosts, setGroupPosts] = useState<GroupPost[]>([]);
  const [newPostText, setNewPostText] = useState('');
  const [loading, setLoading] = useState(true);
  const [joinedGroups, setJoinedGroups] = useState<Set<string>>(new Set());
  const [descExpanded, setDescExpanded] = useState(false);
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function fetchGroups() {
      setLoading(true);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(
          apiUrl(`/api/social/groups/session/${sessionId}?platform=facebook`),
          { headers },
        );
        if (res.ok) {
          const json = await res.json();
          setGroups(json.data || []);
        }
      } catch {
        /* ignore */
      }
      setLoading(false);
    }
    fetchGroups();
  }, [sessionId]);

  async function fetchGroupPosts(groupId: string) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/groups/${groupId}/posts`), { headers });
      if (res.ok) {
        const json = await res.json();
        const all: GroupPost[] = json.data || [];
        const topLevel = all.filter((p) => !p.reply_to_post_id);
        const replyMap: Record<string, GroupPost[]> = {};
        for (const r of all.filter((p) => !!p.reply_to_post_id)) {
          const pid = r.reply_to_post_id!;
          if (!replyMap[pid]) replyMap[pid] = [];
          replyMap[pid].push(r);
        }
        setGroupPosts(topLevel.map((p) => ({ ...p, replies: replyMap[p.id] || [] })));
      }
    } catch {
      /* ignore */
    }
  }

  function openGroup(group: Group) {
    setSelectedGroup(group);
    setGroupPosts([]);
    setNewPostText('');
    setDescExpanded(false);
    setExpandedReplies(new Set());
    fetchGroupPosts(group.id);
  }

  async function handleJoin(groupId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (joinedGroups.has(groupId)) return;
    setJoinedGroups((prev) => new Set([...prev, groupId]));
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/groups/${groupId}/join`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      setJoinedGroups((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
    }
  }

  async function handlePost() {
    if (!newPostText.trim() || !selectedGroup) return;
    const text = newPostText;
    setNewPostText('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/groups/${selectedGroup.id}/posts`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, content: text }),
      });
      if (res.ok) {
        const json = await res.json();
        const created = json.data as GroupPost | undefined;
        if (created) {
          setGroupPosts((prev) => [{ ...created, replies: [] }, ...prev]);
        } else {
          fetchGroupPosts(selectedGroup.id);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function handleLike(postId: string) {
    if (!selectedGroup) return;
    setGroupPosts((prev) =>
      prev.map((p) => {
        if (p.id === postId) return { ...p, like_count: p.like_count + 1, liked_by_me: true };
        const updatedReplies = (p.replies || []).map((r) =>
          r.id === postId ? { ...r, like_count: r.like_count + 1, liked_by_me: true } : r,
        );
        return { ...p, replies: updatedReplies };
      }),
    );
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/groups/${selectedGroup.id}/posts/${postId}/like`), {
        method: 'POST',
        headers,
      });
    } catch {
      /* ignore */
    }
  }

  // ── Groups List View ──
  if (!selectedGroup) {
    return (
      <div
        className="h-full flex flex-col"
        style={{ backgroundColor: '#F0F2F5', colorScheme: 'light' as const }}
      >
        <div
          className="flex items-center px-4 flex-shrink-0"
          style={{
            height: 48,
            backgroundColor: '#FFFFFF',
            borderBottom: '1px solid #DADDE1',
          }}
        >
          <span className="text-[18px] font-bold" style={{ color: '#050505' }}>
            Groups
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div
                className="w-7 h-7 border-2 border-t-transparent rounded-full animate-spin"
                style={{ borderColor: '#1877F2', borderTopColor: 'transparent' }}
              />
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 px-6 text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <path
                  d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"
                  stroke="#CED0D4"
                  strokeWidth="2"
                />
                <circle cx="9" cy="7" r="4" stroke="#CED0D4" strokeWidth="2" />
                <path
                  d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"
                  stroke="#CED0D4"
                  strokeWidth="2"
                />
              </svg>
              <p className="text-[16px] font-bold" style={{ color: '#050505' }}>
                No groups yet
              </p>
              <p className="text-[14px]" style={{ color: '#65676B' }}>
                Groups will appear here as the simulation progresses.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {groups.map((group) => {
                const joined = joinedGroups.has(group.id);
                const typeStyle = getGroupTypeStyle(group.group_type || '');
                return (
                  <div
                    key={group.id}
                    onClick={() => openGroup(group)}
                    className="rounded-xl overflow-hidden cursor-pointer transition-shadow hover:shadow-md"
                    style={{
                      backgroundColor: '#FFFFFF',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                    }}
                  >
                    {/* Cover */}
                    {group.cover_image_url ? (
                      <div className="h-24 overflow-hidden">
                        <img
                          src={group.cover_image_url}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div
                        className="h-24 flex items-center justify-center"
                        style={{
                          background: `linear-gradient(135deg, ${getCoverColor(group.name)}, ${getCoverColor(group.name + 'x')})`,
                        }}
                      >
                        <svg
                          width="36"
                          height="36"
                          viewBox="0 0 24 24"
                          fill="rgba(255,255,255,0.5)"
                        >
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                        </svg>
                      </div>
                    )}

                    {/* Info */}
                    <div className="px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-[15px] font-bold leading-tight truncate"
                            style={{ color: '#050505' }}
                          >
                            {group.name}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {group.group_type && (
                              <span
                                className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ backgroundColor: typeStyle.bg, color: typeStyle.fg }}
                              >
                                {group.group_type.charAt(0).toUpperCase() +
                                  group.group_type.slice(1)}
                              </span>
                            )}
                            <span className="text-[12px]" style={{ color: '#65676B' }}>
                              {group.member_count.toLocaleString()}{' '}
                              {group.member_count === 1 ? 'member' : 'members'}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleJoin(group.id, e)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[13px] font-semibold flex-shrink-0 transition-colors"
                          style={
                            joined
                              ? { backgroundColor: '#E4E6EB', color: '#050505' }
                              : { backgroundColor: '#1877F2', color: '#FFFFFF' }
                          }
                        >
                          {joined ? (
                            <>
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#050505"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Joined
                            </>
                          ) : (
                            'Join'
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Group Feed View ──
  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: '#F0F2F5', colorScheme: 'light' as const }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-3 flex-shrink-0"
        style={{
          height: 48,
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid #DADDE1',
        }}
      >
        <button
          onClick={() => setSelectedGroup(null)}
          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#F2F3F5] transition-colors flex-shrink-0"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#050505"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold leading-tight truncate" style={{ color: '#050505' }}>
            {selectedGroup.name}
          </p>
          <p className="text-[12px]" style={{ color: '#65676B' }}>
            {selectedGroup.member_count.toLocaleString()}{' '}
            {selectedGroup.member_count === 1 ? 'member' : 'members'}
          </p>
        </div>
      </div>

      {/* Description (collapsible) */}
      {selectedGroup.description && (
        <div
          className="px-3 py-2 flex-shrink-0"
          style={{ backgroundColor: '#FFFFFF', borderBottom: '1px solid #DADDE1' }}
        >
          <p className="text-[13px] leading-[18px]" style={{ color: '#050505' }}>
            {descExpanded || selectedGroup.description.length <= 120
              ? selectedGroup.description
              : selectedGroup.description.substring(0, 120) + '...'}
          </p>
          {selectedGroup.description.length > 120 && (
            <button
              onClick={() => setDescExpanded(!descExpanded)}
              className="text-[13px] font-semibold mt-0.5"
              style={{ color: '#1877F2' }}
            >
              {descExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Posts */}
      <div className="flex-1 overflow-y-auto">
        {groupPosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 px-8 text-center">
            <p className="text-[14px]" style={{ color: '#65676B' }}>
              No posts in this group yet. Be the first to post!
            </p>
          </div>
        ) : (
          groupPosts.map((post) => {
            const replies = post.replies || [];
            const showReplies = expandedReplies.has(post.id);
            return (
              <div
                key={post.id}
                className="mt-2"
                style={{
                  backgroundColor: '#FFFFFF',
                  borderTop: '1px solid #CED0D4',
                  borderBottom: '1px solid #CED0D4',
                }}
              >
                {/* Author */}
                <div className="flex items-center gap-2.5 px-3 pt-3 pb-1.5">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-[14px] flex-shrink-0"
                    style={{ backgroundColor: getAvatarColor(post.author_display_name) }}
                  >
                    {post.author_display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-[14px] font-semibold" style={{ color: '#050505' }}>
                      {post.author_display_name}
                    </span>
                    <p className="text-[12px]" style={{ color: '#65676B' }}>
                      {timeAgo(post.created_at)}
                    </p>
                  </div>
                </div>

                {/* Content */}
                <div className="px-3 pb-2">
                  <p
                    className="text-[14px] leading-[20px] whitespace-pre-wrap"
                    style={{ color: '#050505' }}
                  >
                    {post.content}
                  </p>
                </div>

                {/* Counts */}
                <div
                  className="flex items-center justify-between px-3 py-1.5"
                  style={{ borderTop: '1px solid #E4E6EB' }}
                >
                  <div className="flex items-center gap-1">
                    {post.like_count > 0 && (
                      <>
                        <span className="text-[13px]">👍</span>
                        <span className="text-[13px]" style={{ color: '#65676B' }}>
                          {post.like_count}
                        </span>
                      </>
                    )}
                  </div>
                  {replies.length > 0 && (
                    <button
                      onClick={() =>
                        setExpandedReplies((prev) => {
                          const next = new Set(prev);
                          if (next.has(post.id)) next.delete(post.id);
                          else next.add(post.id);
                          return next;
                        })
                      }
                      className="text-[13px] hover:underline"
                      style={{ color: '#65676B' }}
                    >
                      {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div
                  className="flex items-center justify-around px-1 py-0.5"
                  style={{ borderTop: '1px solid #E4E6EB' }}
                >
                  <button
                    onClick={() => handleLike(post.id)}
                    className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded-md hover:bg-[#F2F3F5] transition-colors"
                    style={{ color: post.liked_by_me ? '#1877F2' : '#65676B' }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
                    </svg>
                    <span className="text-[13px] font-semibold">Like</span>
                  </button>
                  <button
                    onClick={() => setExpandedReplies((prev) => new Set([...prev, post.id]))}
                    className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded-md hover:bg-[#F2F3F5] transition-colors"
                    style={{ color: '#65676B' }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    <span className="text-[13px] font-semibold">Reply</span>
                  </button>
                </div>

                {/* Replies (nested) */}
                {showReplies && replies.length > 0 && (
                  <div className="px-3 pt-1 pb-2" style={{ backgroundColor: '#FFFFFF' }}>
                    {replies.map((reply) => (
                      <div key={reply.id} className="flex gap-2 ml-6 mb-2">
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-[10px] flex-shrink-0"
                          style={{ backgroundColor: getAvatarColor(reply.author_display_name) }}
                        >
                          {reply.author_display_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div
                            className="rounded-2xl px-3 py-1.5"
                            style={{ backgroundColor: '#F0F2F5' }}
                          >
                            <span
                              className="text-[12px] font-semibold"
                              style={{ color: '#050505' }}
                            >
                              {reply.author_display_name}
                            </span>
                            <p className="text-[13px]" style={{ color: '#050505' }}>
                              {reply.content}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 ml-3 mt-0.5">
                            <button
                              onClick={() => handleLike(reply.id)}
                              className="text-[11px] font-semibold hover:underline"
                              style={{ color: reply.liked_by_me ? '#1877F2' : '#65676B' }}
                            >
                              Like
                            </button>
                            <span className="text-[11px]" style={{ color: '#65676B' }}>
                              {timeAgo(reply.created_at)}
                            </span>
                            {reply.like_count > 0 && (
                              <span className="text-[11px]" style={{ color: '#65676B' }}>
                                👍 {reply.like_count}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div style={{ height: 64 }} />
      </div>

      {/* Compose bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
        style={{
          backgroundColor: '#FFFFFF',
          borderTop: '1px solid #DADDE1',
        }}
      >
        <div
          className="flex-1 flex items-center rounded-full px-3 py-1.5"
          style={{ backgroundColor: '#F0F2F5' }}
        >
          <input
            type="text"
            value={newPostText}
            onChange={(e) => setNewPostText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handlePost();
            }}
            placeholder="Write something..."
            className="flex-1 bg-transparent text-[14px] outline-none"
            style={{ color: '#050505' }}
          />
        </div>
        <button
          onClick={handlePost}
          disabled={!newPostText.trim()}
          className="px-4 py-1.5 rounded-md text-[13px] font-bold text-white disabled:opacity-40 transition-opacity"
          style={{ backgroundColor: '#1877F2' }}
        >
          Post
        </button>
      </div>
    </div>
  );
}
