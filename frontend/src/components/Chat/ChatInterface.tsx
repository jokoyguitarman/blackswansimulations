import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../lib/api';
import { useWebSocket, type WebSocketEvent } from '../../hooks/useWebSocket';
import { useRealtime } from '../../hooks/useRealtime';
import { supabase } from '../../lib/supabase';
import { VoiceMicButton } from '../VoiceMicButton';
import { VoiceCallPanel } from './VoiceCallPanel';
import { IncomingCallToast } from './IncomingCallToast';
import { useWebRTC } from '../../hooks/useWebRTC';

interface Channel {
  id: string;
  name: string;
  type: string;
  session_id: string;
}

interface DMChannel {
  id: string;
  recipient: {
    id: string;
    full_name: string;
    role: string;
    agency_name?: string;
    team_name?: string;
  } | null;
  last_message: {
    content: string;
    created_at: string;
  } | null;
}

interface Participant {
  id: string;
  full_name: string;
  role: string;
  agency_name?: string;
  team_name?: string;
}

interface Message {
  id: string;
  content: string;
  message_type: string;
  created_at: string;
  channel_id?: string;
  sender_id?: string;
  sender?: {
    id: string;
    full_name: string;
    role: string;
    team_name?: string;
  };
}

interface ChatInterfaceProps {
  sessionId: string;
  /** Called after the user gets an Insider reply (so the map can refetch and show newly revealed POI pins). */
  onInsiderAsked?: () => void;
}

const INSIDER_DM_ID = '__insider__';
const HOSPITAL_DM_PREFIX = '__hospital__';
const toHospitalDMId = (hospitalId: string) => `${HOSPITAL_DM_PREFIX}${hospitalId}`;
const isHospitalDM = (id: string | null) => id?.startsWith(HOSPITAL_DM_PREFIX) ?? false;
const getHospitalIdFromDM = (id: string | null) =>
  id?.startsWith(HOSPITAL_DM_PREFIX) ? id.slice(HOSPITAL_DM_PREFIX.length) : null;

/** Renders Insider message content with markdown-style [text](url) links as clickable anchors. */
function ContentWithLinks({ content }: { content: string }) {
  if (typeof content !== 'string') {
    const safe =
      content != null && typeof content === 'object'
        ? JSON.stringify(content, null, 2)
        : String(content ?? '');
    return <>{safe}</>;
  }
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`t-${key++}`}>{content.slice(lastIndex, match.index)}</span>);
    }
    parts.push(
      <a
        key={`link-${key++}`}
        href={match[2]}
        className="underline text-green-400 hover:text-green-300"
        target="_self"
        rel="noopener noreferrer"
      >
        {match[1]}
      </a>,
    );
    lastIndex = re.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push(<span key={`t-${key++}`}>{content.slice(lastIndex)}</span>);
  }
  return parts.length > 0 ? <>{parts}</> : <>{content}</>;
}

interface InsiderMessage {
  id: string;
  role: 'user' | 'insider';
  content: string;
  created_at: string;
}

export const ChatInterface = ({ sessionId, onInsiderAsked }: ChatInterfaceProps) => {
  const { user } = useAuth();
  const webrtc = useWebRTC(user?.id);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dmChannels, setDmChannels] = useState<DMChannel[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedDM, setSelectedDM] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'channels' | 'dms' | 'voice'>('channels');
  const [showUserList, setShowUserList] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [insiderMessages, setInsiderMessages] = useState<InsiderMessage[]>([]);
  const [insiderLoading, setInsiderLoading] = useState(false);
  const [hospitals, setHospitals] = useState<Array<{ id: string; label: string }>>([]);
  const [hospitalMessagesByHospitalId, setHospitalMessagesByHospitalId] = useState<
    Record<string, InsiderMessage[]>
  >({});
  const [hospitalLoading, setHospitalLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const optimisticMessageIdRef = useRef<string | null>(null);
  const optimisticMessageContentRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Queue messages for channels that aren't currently selected
  const [_queuedMessages, setQueuedMessages] = useState<Map<string, Message[]>>(new Map());

  useEffect(() => {
    // Load participants FIRST to ensure they're available when Realtime messages arrive
    // This prevents "Unknown" labels when messages arrive before participants are loaded
    const initialize = async () => {
      await loadParticipants();
      loadChannels();
      loadDMs();
    };
    initialize();
  }, [sessionId]);

  // Load hospitals when in DM view (for hospital capacity DMs)
  useEffect(() => {
    if (!sessionId || viewMode !== 'dms') return;
    api.sessions
      .hospitalList(sessionId)
      .then((res) => setHospitals(res.data ?? []))
      .catch(() => setHospitals([]));
  }, [sessionId, viewMode]);

  useEffect(() => {
    if (selectedChannel) {
      setSelectedDM(null);
      loadMessages();
      // Queue processing happens in loadMessages after messages are loaded
    }
  }, [selectedChannel]);

  useEffect(() => {
    if (selectedDM) {
      setSelectedChannel(null);
      if (selectedDM === INSIDER_DM_ID || isHospitalDM(selectedDM)) {
        setMessages([]);
        return;
      }
      loadMessages();
      // Queue processing happens in loadMessages after messages are loaded
    }
  }, [selectedDM]);

  // Load Insider Q&A history when opening Insider DM (persists across refresh)
  useEffect(() => {
    if (selectedDM !== INSIDER_DM_ID || !sessionId) return;
    let cancelled = false;
    setInsiderLoading(true);
    api.sessions
      .insiderHistory(sessionId)
      .then((res) => {
        if (cancelled) return;
        const rows = res.data ?? [];
        const mapped: InsiderMessage[] = [];
        for (const row of rows) {
          mapped.push({
            id: `${row.id}-q`,
            role: 'user',
            content: row.question_text,
            created_at: row.asked_at,
          });
          const snippet = row.answer_snippet;
          mapped.push({
            id: `${row.id}-a`,
            role: 'insider',
            content: typeof snippet === 'string' ? snippet : JSON.stringify(snippet ?? ''),
            created_at: row.asked_at,
          });
        }
        setInsiderMessages(mapped);
      })
      .catch(() => {
        if (!cancelled) setInsiderMessages([]);
      })
      .finally(() => {
        if (!cancelled) setInsiderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedDM]);

  const currentChannelId = selectedChannel || selectedDM;

  // Memoize loadDMs to prevent dependency issues
  const loadDMsMemoized = useCallback(async () => {
    try {
      const result = await api.channels.getDMs(sessionId);
      setDmChannels(result.data || []);
    } catch (error) {
      console.error('Failed to load DMs:', error);
    }
  }, [sessionId]);

  // Memoize the onInsert callback to prevent re-subscription loops
  const handleRealtimeMessage = useCallback(
    async (payload: {
      id: string;
      channel_id: string;
      session_id: string;
      sender_id: string;
      content: string;
      type: string;
      created_at: string;
    }) => {
      console.log('[ChatInterface] ✅✅✅ Realtime INSERT event received:', {
        messageId: payload.id,
        channelId: payload.channel_id,
        currentChannel: selectedChannel || selectedDM,
        sessionId: payload.session_id,
        currentSessionId: sessionId,
        content: payload.content.substring(0, 50),
        senderId: payload.sender_id,
        currentUserId: user?.id,
      });

      // Check if this matches our optimistic message (by content and sender)
      // The optimistic message has a temp ID, but the real message has a UUID
      // So we match by content + sender + recent timestamp instead
      const isOptimisticMatch =
        optimisticMessageContentRef.current &&
        optimisticMessageContentRef.current === payload.content &&
        payload.sender_id === user?.id;

      if (isOptimisticMatch) {
        console.log('[ChatInterface] Realtime message matches optimistic message, replacing:', {
          optimisticContent: optimisticMessageContentRef.current,
          realMessageId: payload.id,
        });

        // Get sender info from participants list or current user
        let senderInfo:
          | { id: string; full_name: string; role: string; team_name?: string }
          | undefined;

        if (payload.sender_id === user?.id && user) {
          const selfParticipant = participants.find((p) => p.id === user.id);
          senderInfo = {
            id: user.id,
            full_name: user.displayName || 'You',
            role: user.role || 'unknown',
            team_name: selfParticipant?.team_name,
          };
        } else {
          const participant = participants.find((p) => p.id === payload.sender_id);
          if (participant) {
            senderInfo = {
              id: participant.id,
              full_name: participant.full_name,
              role: participant.role,
              team_name: participant.team_name,
            };
          } else {
            // Try to fetch from API if not in participants list
            try {
              const result = await api.channels.getParticipants(sessionId);
              const allParticipants = result.data || [];
              const foundParticipant = allParticipants.find(
                (p: Participant) => p.id === payload.sender_id,
              );

              if (foundParticipant) {
                senderInfo = {
                  id: foundParticipant.id,
                  full_name: foundParticipant.full_name,
                  role: foundParticipant.role,
                  team_name: foundParticipant.team_name,
                };
                setParticipants((prev) => {
                  if (!prev.find((p) => p.id === foundParticipant.id)) {
                    return [...prev, foundParticipant];
                  }
                  return prev;
                });
              }
            } catch (error) {
              console.warn(
                '[ChatInterface] Could not fetch sender info in optimistic replacement:',
                error,
              );
            }
          }
        }

        const message: Message = {
          id: payload.id,
          content: payload.content,
          message_type: payload.type,
          created_at: payload.created_at,
          sender_id: payload.sender_id,
          sender: senderInfo,
        };

        // Replace optimistic message with real one
        setMessages((prev) => {
          // Remove ALL optimistic messages with matching content and sender
          // This is more aggressive to prevent duplicates
          const filtered = prev.filter((m) => {
            if (m.id.startsWith('temp-')) {
              // Remove if content matches AND sender matches (or both are from current user)
              const contentMatch = m.content === optimisticMessageContentRef.current;
              const senderMatch =
                m.sender_id === payload.sender_id ||
                m.sender?.id === payload.sender_id ||
                (payload.sender_id === user?.id && m.sender_id === user?.id);

              if (contentMatch && senderMatch) {
                console.log('[ChatInterface] Removing optimistic message in replacement:', {
                  optimisticId: m.id,
                  realId: payload.id,
                  content: m.content,
                });
                return false;
              }
            }
            return true;
          });

          // Check if real message already exists
          const exists = filtered.some((m) => m.id === payload.id);
          if (exists) {
            console.log('[ChatInterface] Real message already exists, skipping:', payload.id);
            return filtered;
          }

          // Add real message
          console.log('[ChatInterface] Replacing optimistic with real message:', {
            optimisticContent: optimisticMessageContentRef.current,
            realId: payload.id,
            senderName: message.sender?.full_name || 'Unknown',
          });
          return [...filtered, message];
        });

        // Clear optimistic tracking IMMEDIATELY to prevent further duplicates
        optimisticMessageIdRef.current = null;
        optimisticMessageContentRef.current = null;

        // Clear timeout since Realtime arrived successfully
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }

        // Refresh DM list if needed
        if (selectedDM) {
          loadDMsMemoized();
        }

        return;
      }

      // Hard requirement: Message must be for current session
      if (payload.session_id !== sessionId) {
        console.log('[ChatInterface] Message rejected - not for current session:', {
          messageSession: payload.session_id,
          currentSession: sessionId,
        });
        return;
      }

      const currentChannel = selectedChannel || selectedDM;
      const shouldQueue = !currentChannel || payload.channel_id !== currentChannel;

      // Helper function to create message object
      const createMessage = async (): Promise<Message> => {
        let senderInfo:
          | { id: string; full_name: string; role: string; team_name?: string }
          | undefined;

        if (payload.sender_id === user?.id && user) {
          const selfParticipant = participants.find((p) => p.id === user.id);
          senderInfo = {
            id: user.id,
            full_name: user.displayName || 'You',
            role: user.role || 'unknown',
            team_name: selfParticipant?.team_name,
          };
        } else {
          const participant = participants.find((p) => p.id === payload.sender_id);
          if (participant) {
            senderInfo = {
              id: participant.id,
              full_name: participant.full_name,
              role: participant.role,
              team_name: participant.team_name,
            };
          } else {
            // Participants list might not be loaded yet - try to fetch via API
            // Use the channels API endpoint which has proper access
            console.log('[ChatInterface] Sender not in participants list, fetching via API:', {
              senderId: payload.sender_id,
              currentParticipantsCount: participants.length,
            });

            try {
              const result = await api.channels.getParticipants(sessionId);
              const allParticipants = result.data || [];
              console.log('[ChatInterface] Fetched participants via API:', {
                totalParticipants: allParticipants.length,
                senderId: payload.sender_id,
              });

              const foundParticipant = allParticipants.find(
                (p: Participant) => p.id === payload.sender_id,
              );

              if (foundParticipant) {
                console.log('[ChatInterface] Found sender in API response:', {
                  id: foundParticipant.id,
                  full_name: foundParticipant.full_name,
                  role: foundParticipant.role,
                });

                senderInfo = {
                  id: foundParticipant.id,
                  full_name: foundParticipant.full_name,
                  role: foundParticipant.role,
                  team_name: foundParticipant.team_name,
                };

                // Update participants list for future messages
                setParticipants((prev) => {
                  if (!prev.find((p) => p.id === foundParticipant.id)) {
                    console.log(
                      '[ChatInterface] Adding sender to participants list:',
                      foundParticipant.full_name,
                    );
                    return [...prev, foundParticipant];
                  }
                  return prev;
                });
              } else {
                console.warn(
                  '[ChatInterface] Sender not found in API participants list, checking if trainer:',
                  {
                    senderId: payload.sender_id,
                    currentUserId: user?.id,
                    availableIds: allParticipants.map((p: Participant) => p.id),
                  },
                );

                // The sender might be the trainer (who is not in participants list)
                // Try to fetch session info to get trainer details
                try {
                  const sessionResult = await api.sessions.get(sessionId);
                  const session = sessionResult.data as any;

                  // Trainer can be an object (from join) or just trainer_id
                  const trainerId = session?.trainer?.id || session?.trainer_id;
                  const trainerInfo = session?.trainer || null;

                  if (trainerId === payload.sender_id && trainerInfo) {
                    console.log('[ChatInterface] Sender is trainer, using trainer info:', {
                      id: trainerInfo.id || trainerId,
                      full_name: trainerInfo.full_name,
                      role: trainerInfo.role || 'trainer',
                    });

                    senderInfo = {
                      id: trainerInfo.id || trainerId,
                      full_name: trainerInfo.full_name,
                      role: trainerInfo.role || 'trainer',
                    };

                    // Add trainer to participants list for future messages
                    setParticipants((prev) => {
                      const trainerParticipantId = trainerInfo.id || trainerId;
                      if (!prev.find((p) => p.id === trainerParticipantId)) {
                        console.log('[ChatInterface] Adding trainer to participants list');
                        return [
                          ...prev,
                          {
                            id: trainerParticipantId,
                            full_name: trainerInfo.full_name,
                            role: trainerInfo.role || 'trainer',
                          },
                        ];
                      }
                      return prev;
                    });
                  } else {
                    console.warn(
                      '[ChatInterface] Sender is not trainer and not in participants list:',
                      {
                        senderId: payload.sender_id,
                        trainerId,
                      },
                    );
                  }
                } catch (sessionError) {
                  console.error(
                    '[ChatInterface] Failed to fetch session info to check trainer:',
                    sessionError,
                  );
                }
              }
            } catch (error) {
              console.error('[ChatInterface] Could not fetch sender info via API:', error);
            }
          }
        }

        return {
          id: payload.id,
          content: payload.content,
          message_type: payload.type,
          created_at: payload.created_at,
          sender_id: payload.sender_id, // Store sender_id for side placement
          sender: senderInfo,
        };
      };

      if (shouldQueue) {
        // Queue message for later - channel not selected or doesn't match
        console.log('[ChatInterface] Queueing message - channel not selected or mismatch:', {
          messageChannel: payload.channel_id,
          currentChannel,
          hasCurrentChannel: !!currentChannel,
          reason: !currentChannel ? 'no channel selected' : 'channel mismatch',
        });

        createMessage().then((message) => {
          // If sender info is missing, try to fetch it before queueing
          if (!message.sender && message.sender_id) {
            // Try to fetch sender info immediately
            api.channels
              .getParticipants(sessionId)
              .then((result) => {
                const allParticipants = result.data || [];
                const foundParticipant = allParticipants.find(
                  (p: Participant) => p.id === message.sender_id,
                );

                if (foundParticipant) {
                  message.sender = {
                    id: foundParticipant.id,
                    full_name: foundParticipant.full_name,
                    role: foundParticipant.role,
                    team_name: foundParticipant.team_name,
                  };
                  setParticipants((prev) => {
                    if (!prev.find((p) => p.id === foundParticipant.id)) {
                      return [...prev, foundParticipant];
                    }
                    return prev;
                  });
                }

                // Now queue the message (with or without sender info)
                setQueuedMessages((prev) => {
                  const newQueue = new Map(prev);
                  const channelQueue = newQueue.get(payload.channel_id) || [];
                  // Check if message already queued (prevent duplicates)
                  if (!channelQueue.some((m) => m.id === message.id)) {
                    newQueue.set(payload.channel_id, [...channelQueue, message]);
                    console.log('[ChatInterface] Message queued for channel:', {
                      channelId: payload.channel_id,
                      queueSize: channelQueue.length + 1,
                      hasSender: !!message.sender,
                    });
                  }
                  return newQueue;
                });
              })
              .catch((error) => {
                console.warn(
                  '[ChatInterface] Failed to fetch sender info for queued message:',
                  error,
                );
                // Queue message anyway (will be updated later)
                setQueuedMessages((prev) => {
                  const newQueue = new Map(prev);
                  const channelQueue = newQueue.get(payload.channel_id) || [];
                  if (!channelQueue.some((m) => m.id === message.id)) {
                    newQueue.set(payload.channel_id, [...channelQueue, message]);
                  }
                  return newQueue;
                });
              });
          } else {
            // Sender info is available, queue immediately
            setQueuedMessages((prev) => {
              const newQueue = new Map(prev);
              const channelQueue = newQueue.get(payload.channel_id) || [];
              if (!channelQueue.some((m) => m.id === message.id)) {
                newQueue.set(payload.channel_id, [...channelQueue, message]);
                console.log('[ChatInterface] Message queued for channel:', {
                  channelId: payload.channel_id,
                  queueSize: channelQueue.length + 1,
                });
              }
              return newQueue;
            });
          }
        });

        // Refresh DM list to update last message even if queued
        if (payload.channel_id && selectedDM === payload.channel_id) {
          loadDMsMemoized();
        }
        return;
      }

      // Channel matches - add message immediately
      console.log('[ChatInterface] Processing message for current channel:', {
        messageChannel: payload.channel_id,
        currentChannel,
        messageId: payload.id,
      });

      createMessage()
        .then((message) => {
          console.log('[ChatInterface] Created message with sender info:', {
            messageId: message.id,
            senderId: message.sender_id,
            senderName: message.sender?.full_name || 'Unknown',
            hasSender: !!message.sender,
          });

          setMessages((prev) => {
            // Check if message already exists by ID (prevent duplicates)
            const existingMessage = prev.find((m) => m.id === message.id);
            if (existingMessage) {
              // If message exists but sender info is missing, update it
              if (!existingMessage.sender && message.sender) {
                console.log(
                  '[ChatInterface] Updating existing message with sender info:',
                  message.id,
                );
                return prev.map((m) =>
                  m.id === message.id
                    ? { ...m, sender: message.sender, sender_id: message.sender_id }
                    : m,
                );
              }
              console.log('[ChatInterface] Message already exists by ID, skipping:', message.id);
              return prev;
            }

            // Also check for optimistic message with same content and sender
            // Remove optimistic messages with matching content and sender (check multiple ways)
            const filtered = prev.filter((m) => {
              if (m.id.startsWith('temp-')) {
                // Match by content + sender_id (most reliable)
                const contentMatch = m.content === message.content;
                const senderMatch =
                  m.sender?.id === message.sender_id ||
                  m.sender_id === message.sender_id ||
                  m.sender?.id === message.sender?.id;

                if (contentMatch && senderMatch) {
                  console.log(
                    '[ChatInterface] Removing optimistic message that matches Realtime message:',
                    {
                      optimisticId: m.id,
                      realId: message.id,
                      content: m.content,
                    },
                  );
                  return false;
                }

                // Also remove if content matches and it's from current user (optimistic messages are always from current user)
                if (contentMatch && message.sender_id === user?.id && m.sender_id === user?.id) {
                  console.log(
                    '[ChatInterface] Removing optimistic message (content + user match):',
                    m.id,
                  );
                  return false;
                }
              }
              return true;
            });

            console.log('[ChatInterface] Adding message to current channel:', {
              messageId: message.id,
              senderName: message.sender?.full_name || 'Unknown',
              totalMessages: filtered.length + 1,
            });
            return [...filtered, message];
          });

          // If sender info was missing, try to fetch it again with retries
          // This handles the case where participants list loads after the message arrives
          if (!message.sender && message.sender_id) {
            let retryCount = 0;
            const maxRetries = 3;
            const retryDelay = 500; // Start with 500ms

            const fetchSenderInfo = async () => {
              try {
                const result = await api.channels.getParticipants(sessionId);
                const allParticipants = result.data || [];
                const foundParticipant = allParticipants.find(
                  (p: Participant) => p.id === message.sender_id,
                );

                if (foundParticipant) {
                  console.log('[ChatInterface] Found sender info after retry, updating message:', {
                    messageId: message.id,
                    senderName: foundParticipant.full_name,
                    retryCount,
                  });

                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === message.id
                        ? {
                            ...m,
                            sender: {
                              id: foundParticipant.id,
                              full_name: foundParticipant.full_name,
                              role: foundParticipant.role,
                              team_name: foundParticipant.team_name,
                            },
                            sender_id: foundParticipant.id,
                          }
                        : m,
                    ),
                  );

                  // Update participants list
                  setParticipants((prev) => {
                    if (!prev.find((p) => p.id === foundParticipant.id)) {
                      return [...prev, foundParticipant];
                    }
                    return prev;
                  });
                } else if (retryCount < maxRetries) {
                  // Retry if not found and haven't exceeded max retries
                  retryCount++;
                  setTimeout(fetchSenderInfo, retryDelay * retryCount); // Exponential backoff
                } else {
                  console.warn(
                    '[ChatInterface] Could not find sender info after',
                    maxRetries,
                    'retries:',
                    message.sender_id,
                  );
                }
              } catch (error) {
                console.error('[ChatInterface] Failed to fetch sender info after delay:', error);
                if (retryCount < maxRetries) {
                  retryCount++;
                  setTimeout(fetchSenderInfo, retryDelay * retryCount);
                }
              }
            };

            // Start first retry after initial delay
            setTimeout(fetchSenderInfo, retryDelay);
          }

          // Refresh DM list to update last message
          if (selectedDM) {
            loadDMsMemoized();
          }
        })
        .catch((error) => {
          console.error('[ChatInterface] Error creating message:', error);
        });
    },
    [selectedChannel, selectedDM, sessionId, loadDMsMemoized, user, participants],
  ); // Include all dependencies

  // Supabase Realtime subscription for instant message updates
  // Note: Realtime filters might not work with RLS, so we subscribe to all and filter in JS
  // This is more reliable - Realtime will only send events for rows the user can SELECT
  const { isConnected: realtimeConnected, error: realtimeError } = useRealtime<{
    id: string;
    channel_id: string;
    session_id: string;
    sender_id: string;
    content: string;
    type: string;
    created_at: string;
  }>({
    table: 'chat_messages',
    // Remove filter - Realtime respects RLS, so it will only send events for rows user can SELECT
    // Filtering in JavaScript is more reliable than Realtime filters with RLS
    filter: undefined,
    onInsert: handleRealtimeMessage,
    enabled: !!sessionId,
  });

  // Note: Realtime subscriptions respect RLS automatically
  // If RLS policies allow SELECT, Realtime will work

  // Log Realtime connection status and test subscription
  useEffect(() => {
    if (sessionId && realtimeConnected) {
      const channel = selectedChannel || selectedDM;

      // Diagnostic: Test if user can SELECT messages (RLS check)
      // Realtime only sends events for rows the user can SELECT
      const testRLSAccess = async () => {
        try {
          const { data, error } = await supabase
            .from('chat_messages')
            .select('id, content, session_id')
            .eq('session_id', sessionId)
            .limit(1);

          if (error) {
            console.error('[ChatInterface] RLS BLOCKING: Cannot SELECT messages:', {
              error: error.message,
              code: error.code,
              hint: error.hint,
              details: error.details,
            });
            console.error('[ChatInterface] This is why Realtime is not sending INSERT events!');
            console.error(
              '[ChatInterface] Fix: Verify RLS policies allow SELECT for session participants',
            );
          } else {
            const messageCount = data?.length || 0;
            console.log('[ChatInterface] RLS allows SELECT - can read', messageCount, 'messages');
            console.log(
              '[ChatInterface] Realtime should work. If INSERT events do not arrive, check:',
            );
            console.log(
              '[ChatInterface]    1. Realtime is enabled: SELECT * FROM pg_publication_tables WHERE pubname = supabase_realtime AND tablename = chat_messages',
            );
            console.log('[ChatInterface]    2. Both users are participants in the session');
          }
        } catch (err) {
          console.error('[ChatInterface] Failed to test RLS access:', err);
        }
      };

      // Run test once when connected
      testRLSAccess();

      console.log(`[ChatInterface] Realtime subscription status:`, {
        sessionId,
        connected: realtimeConnected,
        error: realtimeError?.message || null,
        currentChannel: channel,
      });

      if (realtimeConnected) {
        console.log('[ChatInterface] ✅ Realtime is connected - waiting for INSERT events');
        console.log('[ChatInterface] 💡 When a message is sent, you should see:');
        console.log('[ChatInterface]   1. [useRealtime] ✅✅✅ INSERT event received');
        console.log('[ChatInterface]   2. [ChatInterface] ✅✅✅ Realtime INSERT event received');
      } else if (realtimeError) {
        console.error('[ChatInterface] ❌ Realtime subscription error:', realtimeError);
        console.error(
          '[ChatInterface] 💡 This might be due to RLS policies. Make sure migration 019 is run.',
        );
      }
    }
  }, [sessionId, selectedChannel, selectedDM, realtimeConnected, realtimeError]);

  // Keep WebSocket as fallback for additional features
  useWebSocket({
    sessionId,
    channelId: currentChannelId || undefined,
    eventTypes: ['message.sent'],
    onEvent: async (event: WebSocketEvent) => {
      // Fallback: if Realtime didn't catch it, reload messages
      if (event.type === 'message.sent' && event.data.message) {
        const newMessage = event.data.message as Message;
        if (newMessage.channel_id === currentChannelId) {
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === newMessage.id);
            if (exists) return prev;
            return [...prev, newMessage];
          });
        }
      }
    },
    enabled: !!currentChannelId,
  });

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Watch for messages with missing sender info and update them
  // This runs whenever messages or participants change
  useEffect(() => {
    const messagesWithoutSender = messages.filter((m) => !m.sender && m.sender_id);

    if (messagesWithoutSender.length === 0) {
      return; // No messages need updating
    }

    console.log('[ChatInterface] Found messages without sender info:', {
      count: messagesWithoutSender.length,
      participantsCount: participants.length,
      messageIds: messagesWithoutSender.map((m) => m.id),
      senderIds: messagesWithoutSender.map((m) => m.sender_id),
    });

    // If participants list is empty, fetch it first
    if (participants.length === 0) {
      console.log('[ChatInterface] Participants list empty, fetching participants');
      loadParticipants();
      return; // Will retry after participants load
    }

    // First, try to find senders in the current participants list
    let hasUpdates = false;
    const updatedMessages = messages.map((m) => {
      if (!m.sender && m.sender_id) {
        const participant = participants.find((p) => p.id === m.sender_id);
        if (participant) {
          console.log('[ChatInterface] Found sender in participants list, updating message:', {
            messageId: m.id,
            senderName: participant.full_name,
          });
          hasUpdates = true;
          return {
            ...m,
            sender: {
              id: participant.id,
              full_name: participant.full_name,
              role: participant.role,
              team_name: participant.team_name,
            },
          };
        }
      }
      return m;
    });

    // Update messages if we found any senders in participants list
    if (hasUpdates) {
      console.log('[ChatInterface] Updating messages with sender info from participants list');
      setMessages(updatedMessages);
    }

    // For messages still without sender info, try fetching via API
    const stillMissing = updatedMessages.filter((m) => !m.sender && m.sender_id);
    if (stillMissing.length > 0) {
      console.log('[ChatInterface] Some senders still not found, fetching via API:', {
        count: stillMissing.length,
        senderIds: stillMissing.map((m) => m.sender_id),
      });

      // Fetch participants via API and update messages
      api.channels
        .getParticipants(sessionId)
        .then((result) => {
          const allParticipants = result.data || [];
          console.log('[ChatInterface] Fetched participants via API in useEffect:', {
            totalParticipants: allParticipants.length,
            missingSenderIds: stillMissing.map((m) => m.sender_id),
          });

          let foundAny = false;
          const finalUpdatedMessages = updatedMessages.map((m) => {
            if (!m.sender && m.sender_id) {
              const foundParticipant = allParticipants.find(
                (p: Participant) => p.id === m.sender_id,
              );
              if (foundParticipant) {
                console.log('[ChatInterface] Found sender via API, updating message:', {
                  messageId: m.id,
                  senderName: foundParticipant.full_name,
                });
                foundAny = true;
                return {
                  ...m,
                  sender: {
                    id: foundParticipant.id,
                    full_name: foundParticipant.full_name,
                    role: foundParticipant.role,
                    team_name: foundParticipant.team_name,
                  },
                };
              }
            }
            return m;
          });

          if (foundAny) {
            setMessages(finalUpdatedMessages);

            // Update participants list with any new ones found
            setParticipants((prev) => {
              const newParticipants = allParticipants.filter(
                (p: Participant) => !prev.find((existing) => existing.id === p.id),
              );
              if (newParticipants.length > 0) {
                console.log(
                  '[ChatInterface] Adding',
                  newParticipants.length,
                  'new participants to list',
                );
                return [...prev, ...newParticipants];
              }
              return prev;
            });
          } else {
            console.warn(
              '[ChatInterface] Could not find any senders in participants list, checking if trainer:',
              {
                missingSenderIds: stillMissing.map((m) => m.sender_id),
                availableIds: allParticipants.map((p: Participant) => p.id),
              },
            );

            // Try to fetch session to check if sender is trainer
            api.sessions
              .get(sessionId)
              .then((sessionResult) => {
                const session = sessionResult.data as any;

                // Trainer can be an object (from join) or just trainer_id
                const trainerId = session?.trainer?.id || session?.trainer_id;
                const trainerInfo = session?.trainer || null;

                if (trainerId && trainerInfo) {
                  // Check if any missing sender is the trainer
                  const trainerMessages = stillMissing.filter((m) => m.sender_id === trainerId);

                  if (trainerMessages.length > 0) {
                    console.log('[ChatInterface] Found trainer, updating messages:', {
                      trainerId,
                      trainerName: trainerInfo.full_name,
                      messageCount: trainerMessages.length,
                    });

                    const trainerParticipant = {
                      id: trainerInfo.id || trainerId,
                      full_name: trainerInfo.full_name,
                      role: trainerInfo.role || 'trainer',
                    };

                    // Update messages with trainer info
                    const trainerUpdatedMessages = finalUpdatedMessages.map((m) => {
                      if (!m.sender && m.sender_id === trainerId) {
                        return {
                          ...m,
                          sender: trainerParticipant,
                        };
                      }
                      return m;
                    });

                    setMessages(trainerUpdatedMessages);

                    // Add trainer to participants list
                    setParticipants((prev) => {
                      const trainerParticipantId = trainerInfo.id || trainerId;
                      if (!prev.find((p) => p.id === trainerParticipantId)) {
                        return [...prev, trainerParticipant];
                      }
                      return prev;
                    });
                  } else {
                    console.warn('[ChatInterface] Sender is not trainer:', {
                      missingSenderIds: stillMissing.map((m) => m.sender_id),
                      trainerId,
                    });
                  }
                }
              })
              .catch((sessionError) => {
                console.error(
                  '[ChatInterface] Failed to fetch session info to check trainer:',
                  sessionError,
                );
              });
          }
        })
        .catch((error) => {
          console.error(
            '[ChatInterface] Failed to fetch participants via API in useEffect:',
            error,
          );
        });
    }
  }, [messages, participants, sessionId]);

  const loadChannels = async () => {
    try {
      const result = await api.channels.list(sessionId);
      setChannels(result.data as Channel[]);
      if (result.data && result.data.length > 0 && !selectedChannel && !selectedDM) {
        setSelectedChannel((result.data[0] as Channel).id);
      }
    } catch (error) {
      console.error('Failed to load channels:', error);
    } finally {
      setLoading(false);
    }
  };

  // Use the memoized version
  const loadDMs = loadDMsMemoized;

  const loadParticipants = async () => {
    try {
      const result = await api.channels.getParticipants(sessionId);
      const loadedParticipants = result.data || [];
      setParticipants(loadedParticipants);
      console.log('[ChatInterface] Loaded participants:', loadedParticipants.length);
    } catch (error) {
      console.error('Failed to load participants:', error);
    }
  };

  const handleStartDM = async (recipientId: string) => {
    // Prevent creating DM with yourself
    if (user?.id === recipientId) {
      alert('Cannot create a direct message with yourself');
      return;
    }

    try {
      const result = await api.channels.createDM(sessionId, recipientId);
      await loadDMs();
      setSelectedDM(result.data.id);
      setViewMode('dms');
      setShowUserList(false);
    } catch (error) {
      console.error('Failed to start DM:', error);
      alert('Failed to start direct message');
    }
  };

  const loadMessages = async () => {
    const channelId = selectedChannel || selectedDM;
    if (!channelId || channelId === INSIDER_DM_ID || isHospitalDM(channelId)) return;
    try {
      const result = await api.channels.getMessages(channelId, 1, 50);
      const loadedMessages = result.data as Message[];

      // Process queued messages and merge with loaded messages in a single update
      setQueuedMessages((prev) => {
        const channelQueue = prev.get(channelId);

        if (channelQueue && channelQueue.length > 0) {
          console.log('[ChatInterface] Processing queued messages after loadMessages:', {
            channelId,
            queuedCount: channelQueue.length,
            loadedCount: loadedMessages.length,
          });

          // Merge queued messages with loaded messages, avoiding duplicates
          const loadedIds = new Set(loadedMessages.map((m) => m.id));
          const newMessages = channelQueue.filter((m) => !loadedIds.has(m.id));

          if (newMessages.length > 0) {
            console.log(
              '[ChatInterface] Merging',
              newMessages.length,
              'queued messages with loaded messages',
            );
            // Combine loaded and queued messages in one update
            setMessages([...loadedMessages, ...newMessages]);
          } else {
            // No new messages to add, just set loaded messages
            setMessages(loadedMessages);
          }

          // Remove processed messages from queue
          const newQueue = new Map(prev);
          newQueue.delete(channelId);
          return newQueue;
        } else {
          // No queued messages, just set loaded messages
          setMessages(loadedMessages);
          return prev;
        }
      });
    } catch (error) {
      console.error('Failed to load messages:', error);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent, directMessage?: string) => {
    e?.preventDefault();
    const channelId = selectedChannel || selectedDM;
    const raw = directMessage ?? messageInput;
    if (!channelId || !raw.trim()) return;

    const messageContent = raw.trim();
    setMessageInput('');

    // Insider virtual DM: call insider API and show reply in local state
    if (channelId === INSIDER_DM_ID) {
      setInsiderLoading(true);
      const userMsg: InsiderMessage = {
        id: `insider-user-${Date.now()}`,
        role: 'user',
        content: messageContent,
        created_at: new Date().toISOString(),
      };
      setInsiderMessages((prev) => [...prev, userMsg]);
      scrollToBottom();
      try {
        const result = await api.sessions.insiderAsk(sessionId, { content: messageContent });
        const data = result.data as { answer: string; show_map?: boolean };
        const rawAnswer = data.answer;
        const answer = typeof rawAnswer === 'string' ? rawAnswer : JSON.stringify(rawAnswer ?? '');
        const insiderMsg: InsiderMessage = {
          id: `insider-${Date.now()}`,
          role: 'insider',
          content: answer,
          created_at: new Date().toISOString(),
        };
        setInsiderMessages((prev) => [...prev, insiderMsg]);
        scrollToBottom();
        onInsiderAsked?.();
        // Map opens via clickable link in the reply (hash #show-map), not auto-open.
      } catch (err) {
        console.error('Failed to ask Insider:', err);
        setInsiderMessages((prev) => [
          ...prev,
          {
            id: `insider-err-${Date.now()}`,
            role: 'insider',
            content: `[ERROR] ${err instanceof Error ? err.message : 'Failed to get answer'}`,
            created_at: new Date().toISOString(),
          },
        ]);
        scrollToBottom();
      } finally {
        setInsiderLoading(false);
      }
      return;
    }

    // Hospital virtual DM: ask about capacity
    if (isHospitalDM(channelId)) {
      const hospitalId = getHospitalIdFromDM(channelId);
      if (!hospitalId) return;
      setHospitalLoading(true);
      const userMsg: InsiderMessage = {
        id: `hospital-user-${Date.now()}`,
        role: 'user',
        content: messageContent,
        created_at: new Date().toISOString(),
      };
      setHospitalMessagesByHospitalId((prev) => ({
        ...prev,
        [hospitalId]: [...(prev[hospitalId] ?? []), userMsg],
      }));
      scrollToBottom();
      try {
        const result = await api.sessions.hospitalAsk(sessionId, {
          hospital_id: hospitalId,
          content: messageContent,
        });
        const rawHospitalAnswer = (result.data as { answer: string }).answer;
        const hospitalAnswer =
          typeof rawHospitalAnswer === 'string'
            ? rawHospitalAnswer
            : JSON.stringify(rawHospitalAnswer ?? '');
        const hospitalMsg: InsiderMessage = {
          id: `hospital-${Date.now()}`,
          role: 'insider',
          content: hospitalAnswer,
          created_at: new Date().toISOString(),
        };
        setHospitalMessagesByHospitalId((prev) => ({
          ...prev,
          [hospitalId]: [...(prev[hospitalId] ?? []), hospitalMsg],
        }));
        scrollToBottom();
      } catch (err) {
        console.error('Failed to ask hospital:', err);
        setHospitalMessagesByHospitalId((prev) => ({
          ...prev,
          [hospitalId]: [
            ...(prev[hospitalId] ?? []),
            {
              id: `hospital-err-${Date.now()}`,
              role: 'insider',
              content: `[ERROR] ${err instanceof Error ? err.message : 'Failed to get answer'}`,
              created_at: new Date().toISOString(),
            },
          ],
        }));
        scrollToBottom();
      } finally {
        setHospitalLoading(false);
      }
      return;
    }

    // Regular channel/DM: optimistic update and send via channels API
    // Optimistic update: add message immediately
    const tempId = `temp-${Date.now()}`;
    optimisticMessageIdRef.current = tempId;
    optimisticMessageContentRef.current = messageContent;

    const optimisticMessage: Message = {
      id: tempId,
      content: messageContent,
      message_type: 'text',
      created_at: new Date().toISOString(),
      sender_id: user?.id, // Store sender_id for side placement
      sender: user
        ? {
            id: user.id,
            full_name: user.displayName || 'You',
            role: user.role || 'unknown',
          }
        : undefined,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    scrollToBottom();

    try {
      const result = await api.channels.sendMessage(channelId, messageContent);
      console.log('[ChatInterface] Message sent successfully, waiting for Realtime:', {
        messageId: (result.data as { id?: string })?.id,
        tempId,
        content: messageContent,
      });

      // Don't remove optimistic message here - let Realtime replace it
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Set a timeout fallback: if Realtime doesn't fire within 5 seconds, reload messages
      // This is a safety net - Realtime should arrive within 1-2 seconds
      timeoutRef.current = setTimeout(() => {
        // Only reload if optimistic message is still there (Realtime didn't replace it)
        if (optimisticMessageContentRef.current === messageContent) {
          console.warn('[ChatInterface] Realtime delayed - reloading messages as fallback');
          loadMessages();
          optimisticMessageIdRef.current = null;
          optimisticMessageContentRef.current = null;
        }
        timeoutRef.current = null;
      }, 5000); // 5 seconds should be plenty - Realtime usually arrives in <1 second

      // Refresh DM list to update last message
      if (selectedDM) {
        loadDMs();
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      optimisticMessageIdRef.current = null;
      optimisticMessageContentRef.current = null;
      alert('Failed to send message');
      // Restore input
      setMessageInput(messageContent);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_CHANNELS]
          </div>
        </div>
      </div>
    );
  }

  const currentDM = selectedDM ? dmChannels.find((dm) => dm.id === selectedDM) : null;

  return (
    <div className="military-border p-6 h-[600px] flex flex-col">
      {/* Tabs and Channels/DMs Sidebar */}
      <div className="mb-4 border-b border-robotic-yellow/30 pb-4">
        {/* View Mode Tabs */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => {
              setViewMode('channels');
              setSelectedDM(null);
              if (channels.length > 0 && !selectedChannel) {
                setSelectedChannel(channels[0].id);
              }
            }}
            className={`px-3 py-1 text-xs terminal-text uppercase border transition-all ${
              viewMode === 'channels'
                ? 'border-robotic-yellow text-robotic-yellow bg-robotic-yellow/10'
                : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-robotic-yellow/50'
            }`}
          >
            [CHANNELS]
          </button>
          <button
            onClick={() => {
              setViewMode('dms');
              setSelectedChannel(null);
              loadDMs();
            }}
            className={`px-3 py-1 text-xs terminal-text uppercase border transition-all ${
              viewMode === 'dms'
                ? 'border-robotic-yellow text-robotic-yellow bg-robotic-yellow/10'
                : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-robotic-yellow/50'
            }`}
          >
            [DIRECT MESSAGES]
          </button>
          <button
            onClick={() => {
              setViewMode('voice');
              setSelectedChannel(null);
              setSelectedDM(null);
            }}
            className={`px-3 py-1 text-xs terminal-text uppercase border transition-all ${
              viewMode === 'voice'
                ? 'border-green-500 text-green-400 bg-green-500/10'
                : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-green-500/50'
            }`}
          >
            {webrtc.state.isInCall ? '🔴 ' : '🎙 '}[VOICE]
          </button>
          {viewMode === 'dms' && (
            <button
              onClick={() => setShowUserList(!showUserList)}
              className="px-3 py-1 text-xs terminal-text uppercase border border-green-400 text-green-400 hover:bg-green-400/10"
            >
              [+ NEW DM]
            </button>
          )}
        </div>

        {/* Channel/DM List */}
        <div className="flex gap-2 flex-wrap">
          {viewMode === 'channels' &&
            channels.map((channel) => (
              <button
                key={channel.id}
                onClick={() => setSelectedChannel(channel.id)}
                className={`px-4 py-2 text-xs terminal-text uppercase border transition-all ${
                  selectedChannel === channel.id
                    ? 'border-robotic-yellow text-robotic-yellow bg-robotic-yellow/10'
                    : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-robotic-yellow/50'
                }`}
              >
                [{channel.name}]
              </button>
            ))}
          {viewMode === 'dms' && (
            <>
              <button
                key={INSIDER_DM_ID}
                onClick={() => setSelectedDM(INSIDER_DM_ID)}
                className={`px-4 py-2 text-xs terminal-text uppercase border transition-all ${
                  selectedDM === INSIDER_DM_ID
                    ? 'border-green-400 text-green-400 bg-green-400/10'
                    : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-green-400/50'
                }`}
              >
                [INSIDER]
              </button>
              {hospitals.map((h) => {
                const dmId = toHospitalDMId(h.id);
                return (
                  <button
                    key={dmId}
                    onClick={() => setSelectedDM(dmId)}
                    className={`px-4 py-2 text-xs terminal-text uppercase border transition-all ${
                      selectedDM === dmId
                        ? 'border-green-400 text-green-400 bg-green-400/10'
                        : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-green-400/50'
                    }`}
                  >
                    [{h.label}]
                  </button>
                );
              })}
              {dmChannels.map((dm) => (
                <button
                  key={dm.id}
                  onClick={() => setSelectedDM(dm.id)}
                  className={`px-4 py-2 text-xs terminal-text uppercase border transition-all ${
                    selectedDM === dm.id
                      ? 'border-green-400 text-green-400 bg-green-400/10'
                      : 'border-robotic-gray-200 text-robotic-gray-50 hover:border-green-400/50'
                  }`}
                >
                  [{dm.recipient?.full_name || 'Unknown'}]
                </button>
              ))}
            </>
          )}
        </div>

        {/* User List for Starting DMs */}
        {showUserList && (
          <div className="mt-3 p-3 bg-robotic-gray-200 border border-green-400/50 max-h-40 overflow-y-auto">
            <p className="text-xs terminal-text text-green-400 mb-2 uppercase">[SELECT_USER]</p>
            <div className="space-y-1">
              {participants
                .filter((participant) => participant.id !== user?.id)
                .map((participant) => (
                  <button
                    key={participant.id}
                    onClick={() => handleStartDM(participant.id)}
                    className="w-full text-left px-2 py-1 text-xs terminal-text hover:bg-green-400/10 border border-transparent hover:border-green-400/30"
                  >
                    {participant.full_name} [{participant.team_name || participant.role}]
                  </button>
                ))}
              {participants.filter((p) => p.id !== user?.id).length === 0 && (
                <p className="text-xs terminal-text text-robotic-yellow/50">
                  No other participants
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Incoming call toast — always visible */}
      {webrtc.incomingCall && (
        <IncomingCallToast
          callId={webrtc.incomingCall.callId}
          callerName={
            participants.find((p) => p.id === webrtc.incomingCall?.from)?.full_name ?? 'Unknown'
          }
          onAccept={webrtc.acceptCall}
          onReject={webrtc.rejectCall}
        />
      )}

      {/* Voice panel */}
      {viewMode === 'voice' && user && (
        <div className="flex-1 overflow-y-auto mb-4">
          <VoiceCallPanel sessionId={sessionId} currentUserId={user.id} />
        </div>
      )}

      {/* Messages (hidden in voice mode) */}
      <div
        className={`flex-1 overflow-y-auto mb-4 space-y-2 ${viewMode === 'voice' ? 'hidden' : ''}`}
      >
        {currentChannelId ? (
          <>
            {selectedDM === INSIDER_DM_ID && (
              <div className="mb-3 pb-3 border-b border-green-400/30">
                <p className="text-xs terminal-text text-green-400 uppercase">
                  Direct Message with: Insider [trainer]
                </p>
              </div>
            )}
            {isHospitalDM(selectedDM) && (
              <div className="mb-3 pb-3 border-b border-green-400/30">
                <p className="text-xs terminal-text text-green-400 uppercase">
                  Direct Message with:{' '}
                  {hospitals.find((h) => toHospitalDMId(h.id) === selectedDM)?.label ?? 'Hospital'}
                </p>
              </div>
            )}
            {currentDM && selectedDM !== INSIDER_DM_ID && !isHospitalDM(selectedDM) && (
              <div className="mb-3 pb-3 border-b border-green-400/30">
                <p className="text-xs terminal-text text-green-400 uppercase">
                  Direct Message with: {currentDM.recipient?.full_name || 'Unknown'} [
                  {currentDM.recipient?.team_name || currentDM.recipient?.role || 'UNKNOWN'}]
                </p>
              </div>
            )}
            {selectedDM === INSIDER_DM_ID ? (
              <>
                {insiderMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`military-border p-3 ${msg.role === 'user' ? 'ml-8' : 'mr-8'} border-green-400/30`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-xs terminal-text font-semibold text-green-400">
                        {msg.role === 'user' ? user?.displayName || 'You' : 'Insider'} [
                        {msg.role === 'user'
                          ? participants.find((p) => p.id === user?.id)?.team_name ||
                            user?.role ||
                            'unknown'
                          : 'trainer'}
                        ]
                      </span>
                      <span className="text-xs terminal-text text-green-400/50">
                        {new Date(msg.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm terminal-text text-green-400/90 whitespace-pre-wrap">
                      <ContentWithLinks content={msg.content} />
                    </p>
                  </div>
                ))}
                {insiderLoading && (
                  <div className="mr-8 military-border p-3 border-green-400/30">
                    <p className="text-xs terminal-text text-green-400/50">Insider is typing...</p>
                  </div>
                )}
                {insiderMessages.length === 0 && !insiderLoading && (
                  <div className="text-center py-8">
                    <p className="text-sm terminal-text text-green-400/50">
                      [ASK_INSIDER] Ask about map, layout, hospitals, police, fire stations, routes,
                      etc.
                    </p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            ) : isHospitalDM(selectedDM) ? (
              <>
                {(hospitalMessagesByHospitalId[getHospitalIdFromDM(selectedDM) ?? ''] ?? []).map(
                  (msg) => (
                    <div
                      key={msg.id}
                      className={`military-border p-3 ${msg.role === 'user' ? 'ml-8' : 'mr-8'} border-green-400/30`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-xs terminal-text font-semibold text-green-400">
                          {msg.role === 'user'
                            ? user?.displayName || 'You'
                            : (hospitals.find((h) => toHospitalDMId(h.id) === selectedDM)?.label ??
                              'Hospital')}{' '}
                          [
                          {msg.role === 'user'
                            ? participants.find((p) => p.id === user?.id)?.team_name ||
                              user?.role ||
                              'unknown'
                            : 'hospital'}
                          ]
                        </span>
                        <span className="text-xs terminal-text text-green-400/50">
                          {new Date(msg.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm terminal-text text-green-400/90 whitespace-pre-wrap">
                        <ContentWithLinks content={msg.content} />
                      </p>
                    </div>
                  ),
                )}
                {hospitalLoading && (
                  <div className="mr-8 military-border p-3 border-green-400/30">
                    <p className="text-xs terminal-text text-green-400/50">
                      Hospital is responding...
                    </p>
                  </div>
                )}
                {(hospitalMessagesByHospitalId[getHospitalIdFromDM(selectedDM) ?? ''] ?? [])
                  .length === 0 &&
                  !hospitalLoading && (
                    <div className="text-center py-8">
                      <p className="text-sm terminal-text text-green-400/50">
                        Ask about capacity, availability, or whether they can take patients.
                      </p>
                    </div>
                  )}
                <div ref={messagesEndRef} />
              </>
            ) : (
              <>
                {messages.map((message) => {
                  // Determine if message is from current user
                  // Check sender.id first, then fall back to sender_id if sender is undefined
                  const isCurrentUser =
                    message.sender?.id === user?.id ||
                    (message.sender_id && message.sender_id === user?.id);

                  return (
                    <div
                      key={message.id}
                      className={`military-border p-3 ${
                        isCurrentUser ? 'ml-8' : 'mr-8'
                      } ${selectedDM ? 'border-green-400/30' : ''}`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span
                          className={`text-xs terminal-text font-semibold ${selectedDM ? 'text-green-400' : 'text-robotic-yellow'}`}
                        >
                          {message.sender?.full_name || 'Unknown'} [
                          {message.sender?.team_name || message.sender?.role || 'UNKNOWN'}]
                        </span>
                        <span
                          className={`text-xs terminal-text ${selectedDM ? 'text-green-400/50' : 'text-robotic-yellow/50'}`}
                        >
                          {new Date(message.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <p
                        className={`text-sm terminal-text ${selectedDM ? 'text-green-400/90' : 'text-robotic-yellow/90'}`}
                      >
                        {message.message_type === 'voice_transcript' && (
                          <span className="mr-1" title="Voice transcript">
                            🎙
                          </span>
                        )}
                        {typeof message.content === 'string'
                          ? message.content
                          : JSON.stringify(message.content)}
                      </p>
                    </div>
                  );
                })}
                {messages.length === 0 && (
                  <div className="text-center py-8">
                    <p
                      className={`text-sm terminal-text ${selectedDM ? 'text-green-400/50' : 'text-robotic-yellow/50'}`}
                    >
                      [NO_MESSAGES] No messages yet
                    </p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              {viewMode === 'channels'
                ? '[SELECT_CHANNEL] Select a channel'
                : '[SELECT_DM] Select a conversation or start a new DM'}
            </p>
          </div>
        )}
      </div>

      {/* Message Input (hidden in voice mode) */}
      {currentChannelId && viewMode !== 'voice' && (
        <form onSubmit={(e) => handleSendMessage(e)} className="flex gap-2">
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder="Type or speak a message..."
            className="flex-1 px-4 py-2 military-input terminal-text text-sm"
          />
          <VoiceMicButton autoSend onTranscript={(text) => handleSendMessage(undefined, text)} />
          <button type="submit" className="military-button px-6 py-2">
            [SEND]
          </button>
        </form>
      )}
    </div>
  );
};
