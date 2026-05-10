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

interface FacebookEventsViewProps {
  sessionId: string;
}

interface EventObj {
  id: string;
  title: string;
  description: string;
  event_type: string;
  location: string;
  event_date: string;
  cover_image_url?: string;
  organizer_name?: string;
  going_count: number;
  interested_count: number;
  platform: string;
  created_at: string;
}

interface DiscussionPost {
  id: string;
  author_name: string;
  author_avatar?: string;
  content: string;
  created_at: string;
}

type ResponseType = 'going' | 'interested' | 'not_going';

const EVENT_TYPE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  protest: { bg: '#FEE2E2', fg: '#EF4444', label: 'Protest' },
  vigil: { bg: '#EDE9FE', fg: '#8B5CF6', label: 'Vigil' },
  community_meeting: { bg: '#DBEAFE', fg: '#1877F2', label: 'Community Meeting' },
  safety_patrol: { bg: '#FFEDD5', fg: '#F97316', label: 'Safety Patrol' },
  solidarity: { bg: '#DCFCE7', fg: '#22C55E', label: 'Solidarity' },
};

const PLACEHOLDER_COLORS: Record<string, string> = {
  protest: '#EF4444',
  vigil: '#8B5CF6',
  community_meeting: '#1877F2',
  safety_patrol: '#F97316',
  solidarity: '#22C55E',
};

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const FacebookEventsView: React.FC<FacebookEventsViewProps> = ({ sessionId }) => {
  const [events, setEvents] = useState<EventObj[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<EventObj | null>(null);
  const [myResponse, setMyResponse] = useState<ResponseType | null>(null);
  const [discussions, setDiscussions] = useState<DiscussionPost[]>([]);
  const [newDiscussionText, setNewDiscussionText] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    event_type: 'community_meeting',
    location: '',
    event_date: '',
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchEvents();
  }, [sessionId]);

  async function fetchEvents() {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/events/session/${sessionId}?platform=facebook`), {
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        setEvents(Array.isArray(data) ? data : data.events || []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  async function openEventDetail(ev: EventObj) {
    setSelectedEvent(ev);
    setMyResponse(null);
    setDiscussions([]);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(apiUrl(`/api/social/events/${ev.id}`), { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.discussions) setDiscussions(data.discussions);
        if (data.my_response) setMyResponse(data.my_response);
        if (data.event) {
          setSelectedEvent(data.event);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function handleRespond(response: ResponseType) {
    if (!selectedEvent) return;
    setMyResponse(response);
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/events/${selectedEvent.id}/respond`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ response }),
      });
      openEventDetail(selectedEvent);
    } catch {
      /* ignore */
    }
  }

  async function handlePostDiscussion() {
    if (!selectedEvent || !newDiscussionText.trim()) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl(`/api/social/events/${selectedEvent.id}/discuss`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ session_id: sessionId, content: newDiscussionText.trim() }),
      });
      setNewDiscussionText('');
      openEventDetail(selectedEvent);
    } catch {
      /* ignore */
    }
  }

  async function handleCreateEvent() {
    if (!createForm.title.trim()) return;
    try {
      const headers = await getAuthHeaders();
      await fetch(apiUrl('/api/social/events'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          title: createForm.title,
          description: createForm.description,
          event_type: createForm.event_type,
          location: createForm.location,
          event_date: createForm.event_date,
          platform: 'facebook',
        }),
      });
      setShowCreateModal(false);
      setCreateForm({
        title: '',
        description: '',
        event_type: 'community_meeting',
        location: '',
        event_date: '',
      });
      fetchEvents();
    } catch {
      /* ignore */
    }
  }

  /* ── Event Detail View ─────────────────────────────────────────────── */

  if (selectedEvent) {
    const typeInfo =
      EVENT_TYPE_COLORS[selectedEvent.event_type] || EVENT_TYPE_COLORS.community_meeting;
    const placeholderColor = PLACEHOLDER_COLORS[selectedEvent.event_type] || '#1877F2';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderBottom: '1px solid #E4E6EB',
            background: '#fff',
            position: 'sticky',
            top: 0,
            zIndex: 5,
          }}
        >
          <button
            onClick={() => setSelectedEvent(null)}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 6,
              color: '#1877F2',
            }}
          >
            ←
          </button>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Event</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Cover */}
          {selectedEvent.cover_image_url ? (
            <img
              src={selectedEvent.cover_image_url}
              alt=""
              style={{ width: '100%', height: 160, objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: 160,
                background: `linear-gradient(135deg, ${placeholderColor}CC, ${placeholderColor}88)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 40,
              }}
            >
              📅
            </div>
          )}

          <div style={{ padding: '14px 14px 0' }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
              {selectedEvent.title}
            </div>
            <div style={{ fontSize: 13, color: '#65676B', marginBottom: 2 }}>
              📅 {selectedEvent.event_date || 'TBD'}
            </div>
            <div style={{ fontSize: 13, color: '#65676B', marginBottom: 2 }}>
              📍 {selectedEvent.location || 'Location TBD'}
            </div>
            {selectedEvent.organizer_name && (
              <div style={{ fontSize: 13, color: '#65676B', marginBottom: 8 }}>
                👤 Organized by {selectedEvent.organizer_name}
              </div>
            )}

            <span
              style={{
                display: 'inline-block',
                padding: '2px 10px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 600,
                background: typeInfo.bg,
                color: typeInfo.fg,
                marginBottom: 10,
              }}
            >
              {typeInfo.label}
            </span>

            {/* Response buttons */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {(['going', 'interested', 'not_going'] as ResponseType[]).map((r) => {
                const labels: Record<ResponseType, string> = {
                  going: '✓ Going',
                  interested: '★ Interested',
                  not_going: "✕ Can't Go",
                };
                const active = myResponse === r;
                return (
                  <button
                    key={r}
                    onClick={() => handleRespond(r)}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      border: active ? '2px solid #1877F2' : '1px solid #CED0D4',
                      borderRadius: 8,
                      background: active ? '#E7F3FF' : '#fff',
                      color: active ? '#1877F2' : '#050505',
                      fontWeight: active ? 700 : 500,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {labels[r]}
                  </button>
                );
              })}
            </div>

            {/* Stats */}
            <div style={{ fontSize: 13, color: '#65676B', marginBottom: 12 }}>
              <span style={{ fontWeight: 600, color: '#050505' }}>{selectedEvent.going_count}</span>{' '}
              going
              {' · '}
              <span style={{ fontWeight: 600, color: '#050505' }}>
                {selectedEvent.interested_count}
              </span>{' '}
              interested
            </div>

            {/* Description */}
            {selectedEvent.description && (
              <div style={{ fontSize: 14, lineHeight: 1.45, color: '#050505', marginBottom: 16 }}>
                {selectedEvent.description}
              </div>
            )}

            {/* Discussion section */}
            <div style={{ borderTop: '1px solid #E4E6EB', paddingTop: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Discussion</div>

              {discussions.length === 0 && (
                <div style={{ fontSize: 13, color: '#65676B', marginBottom: 10 }}>
                  No posts yet. Start the conversation!
                </div>
              )}

              {discussions.map((d) => (
                <div key={d.id} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: '#E4E6EB',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    {d.author_avatar || d.author_name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div>
                    <div
                      style={{
                        background: '#F0F2F5',
                        borderRadius: 12,
                        padding: '8px 12px',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{d.author_name}</div>
                      <div style={{ fontSize: 13 }}>{d.content}</div>
                    </div>
                    <div style={{ fontSize: 11, color: '#65676B', marginTop: 2, paddingLeft: 12 }}>
                      {formatRelativeTime(d.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Discussion compose */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 12px',
            borderTop: '1px solid #E4E6EB',
            background: '#fff',
          }}
        >
          <input
            value={newDiscussionText}
            onChange={(e) => setNewDiscussionText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handlePostDiscussion()}
            placeholder="Write a comment..."
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 20,
              border: '1px solid #CED0D4',
              fontSize: 13,
              outline: 'none',
              background: '#F0F2F5',
            }}
          />
          <button
            onClick={handlePostDiscussion}
            disabled={!newDiscussionText.trim()}
            style={{
              background: newDiscussionText.trim() ? '#1877F2' : '#E4E6EB',
              color: newDiscussionText.trim() ? '#fff' : '#BCC0C4',
              border: 'none',
              borderRadius: 20,
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: newDiscussionText.trim() ? 'pointer' : 'default',
            }}
          >
            Post
          </button>
        </div>
      </div>
    );
  }

  /* ── Events List View ──────────────────────────────────────────────── */

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#F0F2F5' }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid #E4E6EB',
          background: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 18 }}>Events</span>
        <button
          onClick={() => setShowCreateModal(true)}
          style={{
            background: '#1877F2',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + Create Event
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {loading && events.length === 0 && (
          <div style={{ textAlign: 'center', color: '#65676B', padding: 30, fontSize: 14 }}>
            Loading events...
          </div>
        )}

        {!loading && events.length === 0 && (
          <div style={{ textAlign: 'center', color: '#65676B', padding: 30, fontSize: 14 }}>
            No events yet. Create one to get started!
          </div>
        )}

        {events.map((ev) => {
          const typeInfo = EVENT_TYPE_COLORS[ev.event_type] || EVENT_TYPE_COLORS.community_meeting;
          const placeholderColor = PLACEHOLDER_COLORS[ev.event_type] || '#1877F2';

          return (
            <div
              key={ev.id}
              onClick={() => openEventDetail(ev)}
              style={{
                background: '#fff',
                borderRadius: 10,
                marginBottom: 10,
                overflow: 'hidden',
                cursor: 'pointer',
                boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                transition: 'box-shadow 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)')}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)')}
            >
              {/* Cover */}
              {ev.cover_image_url ? (
                <img
                  src={ev.cover_image_url}
                  alt=""
                  style={{ width: '100%', height: 110, objectFit: 'cover' }}
                />
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: 110,
                    background: `linear-gradient(135deg, ${placeholderColor}CC, ${placeholderColor}55)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 32,
                  }}
                >
                  📅
                </div>
              )}

              <div style={{ padding: '10px 12px 12px' }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{ev.title}</div>
                <div style={{ fontSize: 12, color: '#65676B', marginBottom: 2 }}>
                  📅 {ev.event_date || 'TBD'} · 📍 {ev.location || 'TBD'}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 11,
                      fontWeight: 600,
                      background: typeInfo.bg,
                      color: typeInfo.fg,
                    }}
                  >
                    {typeInfo.label}
                  </span>
                  <span style={{ fontSize: 12, color: '#65676B' }}>
                    {ev.going_count} going · {ev.interested_count} interested
                  </span>
                </div>

                {ev.organizer_name && (
                  <div style={{ fontSize: 12, color: '#65676B', marginTop: 4 }}>
                    By {ev.organizer_name}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Event Modal */}
      {showCreateModal && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCreateModal(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 12,
              width: '100%',
              maxWidth: 360,
              maxHeight: '90%',
              overflowY: 'auto',
              padding: 18,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 14 }}>Create Event</div>

            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#65676B',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Title
            </label>
            <input
              value={createForm.title}
              onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Event title"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CED0D4',
                fontSize: 14,
                marginBottom: 12,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />

            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#65676B',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Description
            </label>
            <textarea
              value={createForm.description}
              onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What's this event about?"
              rows={3}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CED0D4',
                fontSize: 14,
                marginBottom: 12,
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />

            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#65676B',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Event Type
            </label>
            <select
              value={createForm.event_type}
              onChange={(e) => setCreateForm((f) => ({ ...f, event_type: e.target.value }))}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CED0D4',
                fontSize: 14,
                marginBottom: 12,
                outline: 'none',
                background: '#fff',
                boxSizing: 'border-box',
              }}
            >
              <option value="protest">Protest</option>
              <option value="vigil">Vigil</option>
              <option value="community_meeting">Community Meeting</option>
              <option value="safety_patrol">Safety Patrol</option>
              <option value="solidarity">Solidarity</option>
            </select>

            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#65676B',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Location
            </label>
            <input
              value={createForm.location}
              onChange={(e) => setCreateForm((f) => ({ ...f, location: e.target.value }))}
              placeholder="Where is this happening?"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CED0D4',
                fontSize: 14,
                marginBottom: 12,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />

            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#65676B',
                display: 'block',
                marginBottom: 4,
              }}
            >
              Date / Time
            </label>
            <input
              value={createForm.event_date}
              onChange={(e) => setCreateForm((f) => ({ ...f, event_date: e.target.value }))}
              placeholder="e.g. Tonight 8pm, Saturday 3pm"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CED0D4',
                fontSize: 14,
                marginBottom: 16,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setShowCreateModal(false)}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: 8,
                  border: '1px solid #CED0D4',
                  background: '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: '#050505',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEvent}
                disabled={!createForm.title.trim()}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: 8,
                  border: 'none',
                  background: createForm.title.trim() ? '#1877F2' : '#E4E6EB',
                  color: createForm.title.trim() ? '#fff' : '#BCC0C4',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: createForm.title.trim() ? 'pointer' : 'default',
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FacebookEventsView;
