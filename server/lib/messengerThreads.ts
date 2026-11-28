/**
 * Group direct messages into the thread list the messenger routes return.
 * Shared by the personal inbox and a single page inbox so the two stay the same shape.
 */

export interface MessengerThreadMessage {
  thread_id: string;
  created_at: string;
  sender_handle: string;
  recipient_handle: string;
  sender_display_name: string | null;
  is_read: boolean | null;
}

export interface MessengerThreadSummary<T extends MessengerThreadMessage> {
  thread_id: string;
  latest_message: T;
  unread_count: number;
  other_participant: { handle: string; display_name: string | null };
  is_org_page_thread: boolean;
}

export function summariseMessengerThreads<T extends MessengerThreadMessage>(
  messages: readonly T[],
  pageHandles: readonly string[],
  playerHandle: string,
): MessengerThreadSummary<T>[] {
  const pageHandleSet = new Set(pageHandles);
  const threadMap = new Map<string, MessengerThreadSummary<T>>();

  for (const msg of messages) {
    const existing = threadMap.get(msg.thread_id);
    const isOrgThread =
      pageHandleSet.has(msg.sender_handle) || pageHandleSet.has(msg.recipient_handle);
    const isIncoming = isOrgThread
      ? pageHandleSet.has(msg.recipient_handle)
      : msg.recipient_handle === playerHandle;
    const otherHandle = isIncoming ? msg.sender_handle : msg.recipient_handle;
    const otherDisplayName = isIncoming ? msg.sender_display_name : otherHandle;

    if (!existing) {
      threadMap.set(msg.thread_id, {
        thread_id: msg.thread_id,
        latest_message: msg,
        unread_count: isIncoming && !msg.is_read ? 1 : 0,
        other_participant: { handle: otherHandle, display_name: otherDisplayName },
        is_org_page_thread: !!isOrgThread,
      });
    } else {
      if (new Date(msg.created_at) > new Date(existing.latest_message.created_at)) {
        existing.latest_message = msg;
      }
      if (isIncoming && !msg.is_read) {
        existing.unread_count += 1;
      }
      if (
        !existing.other_participant.display_name ||
        existing.other_participant.display_name === existing.other_participant.handle
      ) {
        if (otherDisplayName && otherDisplayName !== otherHandle) {
          existing.other_participant.display_name = otherDisplayName;
        }
      }
    }
  }

  return Array.from(threadMap.values()).sort(
    (a, b) =>
      new Date(b.latest_message.created_at).getTime() -
      new Date(a.latest_message.created_at).getTime(),
  );
}
