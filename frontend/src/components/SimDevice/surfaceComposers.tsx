import React, { type KeyboardEvent, type Ref } from 'react';
import { showComposer } from '../../lib/readOnlySurface';

/** Post box on an organisation page. Hidden when the page is read-only. */
export function PagePostComposer({
  readOnly,
  isFacebook,
  pageName,
  value,
  onChange,
  onPost,
}: {
  readOnly: boolean;
  isFacebook: boolean;
  pageName: string;
  value: string;
  onChange: (value: string) => void;
  onPost: () => void;
}) {
  if (!showComposer(readOnly)) return null;
  return (
    <div
      className="mx-4 mt-3 p-3 rounded-lg"
      data-composer="page-post"
      style={{ backgroundColor: isFacebook ? '#FFFFFF' : '#16181C' }}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Post as ${pageName}...`}
        className="w-full bg-transparent text-sm resize-none outline-none"
        style={{
          color: isFacebook ? '#050505' : '#E7E9EA',
          minHeight: 60,
        }}
        rows={2}
      />
      <div className="flex justify-end mt-2">
        <button
          onClick={onPost}
          disabled={!value.trim()}
          className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
          style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
        >
          Post as {pageName}
        </button>
      </div>
    </div>
  );
}

/** Like and Reply on a page comment. Hidden for a staff read-only profile. */
export function CommentActions({
  readOnly,
  isFacebook,
  liked,
  onLike,
  onReply,
}: {
  readOnly: boolean;
  isFacebook: boolean;
  liked: boolean;
  onLike: () => void;
  onReply: () => void;
}) {
  if (!showComposer(readOnly)) return null;
  return (
    <React.Fragment>
      <button
        onClick={onLike}
        data-composer="comment-like"
        className="text-[12px] font-semibold"
        style={{
          color: liked ? (isFacebook ? '#1877F2' : '#1D9BF0') : isFacebook ? '#65676B' : '#71767B',
        }}
      >
        Like
      </button>
      <button
        onClick={onReply}
        data-composer="comment-reply"
        className="text-[12px] font-semibold"
        style={{ color: isFacebook ? '#65676B' : '#71767B' }}
      >
        Reply
      </button>
    </React.Fragment>
  );
}

/** Comment box under a page post, including the "replying to" line. */
export function CommentComposer({
  readOnly,
  isFacebook,
  pageName,
  value,
  onChange,
  onPost,
  replyingToName,
  onCancelReply,
  inputRef,
}: {
  readOnly: boolean;
  isFacebook: boolean;
  pageName: string;
  value: string;
  onChange: (value: string) => void;
  onPost: () => void;
  replyingToName: string | null;
  onCancelReply: () => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  if (!showComposer(readOnly)) return null;
  return (
    <div
      className="flex-shrink-0"
      data-composer="comment"
      style={{
        backgroundColor: isFacebook ? '#FFFFFF' : '#16181C',
        borderTop: `1px solid ${isFacebook ? '#E4E6EB' : '#2F3336'}`,
      }}
    >
      {replyingToName && (
        <div className="flex items-center justify-between px-4 pt-2 pb-1">
          <span className="text-[12px]" style={{ color: isFacebook ? '#65676B' : '#71767B' }}>
            Replying to {replyingToName}
          </span>
          <button
            onClick={onCancelReply}
            className="text-[12px] font-semibold"
            style={{ color: isFacebook ? '#1877F2' : '#1D9BF0' }}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-3">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onPost();
            }
          }}
          placeholder={replyingToName ? `Reply as ${pageName}...` : `Comment as ${pageName}...`}
          className="flex-1 px-3 py-2 rounded-full text-[14px] outline-none"
          style={{
            backgroundColor: isFacebook ? '#F0F2F5' : '#2F3336',
            color: isFacebook ? '#050505' : '#E7E9EA',
          }}
        />
        <button
          onClick={onPost}
          disabled={!value.trim()}
          className="px-3 py-2 rounded-full text-[13px] font-semibold text-white disabled:opacity-40"
          style={{ backgroundColor: isFacebook ? '#1877F2' : '#1D9BF0' }}
        >
          Post
        </button>
      </div>
    </div>
  );
}

/** Pencil button that opens a new messenger thread. */
export function MessengerNewMessageButton({
  readOnly,
  onClick,
}: {
  readOnly: boolean;
  onClick: () => void;
}) {
  if (!showComposer(readOnly)) return null;
  return (
    <button
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 6,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-label="New message"
      data-composer="new-message"
      onClick={onClick}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#1877F2"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}

/** "Aa" reply bar on an open messenger thread. */
export function MessengerReplyBar({
  readOnly,
  value,
  onChange,
  onKeyDown,
  onSend,
  inputRef,
}: {
  readOnly: boolean;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSend: () => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  if (!showComposer(readOnly)) return null;
  return (
    <div
      data-composer="reply"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '8px 12px',
        borderTop: '1px solid #E4E6EB',
        gap: 8,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Aa"
        style={{
          flex: 1,
          border: 'none',
          backgroundColor: '#F0F2F5',
          borderRadius: 20,
          padding: '8px 14px',
          fontSize: 14,
          outline: 'none',
          color: '#050505',
        }}
      />
      <button
        onClick={onSend}
        disabled={!value.trim()}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: value.trim() ? 1 : 0.4,
        }}
        aria-label="Send"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#1877F2">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
    </div>
  );
}

/** New-message panel (recipient and body). */
export function MessengerComposePanel({
  readOnly,
  open,
  recipient,
  text,
  handles,
  onRecipient,
  onText,
  onSend,
  onClose,
}: {
  readOnly: boolean;
  open: boolean;
  recipient: string;
  text: string;
  handles: readonly string[];
  onRecipient: (value: string) => void;
  onText: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
}) {
  if (!showComposer(readOnly) || !open) return null;
  const canSend = recipient.length > 0 && text.trim().length > 0;
  return (
    <div
      data-composer="compose"
      style={{ padding: 16, borderBottom: '1px solid #E4E6EB', backgroundColor: '#FFFFFF' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: '#050505' }}>New Message</span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 18,
            color: '#65676B',
          }}
        >
          &#10005;
        </button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: '#65676B', display: 'block', marginBottom: 4 }}>
          To:
        </label>
        <select
          value={recipient}
          onChange={(e) => onRecipient(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #CED0D4',
            fontSize: 14,
            color: '#050505',
            backgroundColor: '#F0F2F5',
          }}
        >
          <option value="">Select a person...</option>
          {handles
            .filter((handle) => handle && !handle.startsWith('@player'))
            .map((handle) => (
              <option key={handle} value={handle}>
                {handle}
              </option>
            ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSend();
          }}
          placeholder="Type a message..."
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 20,
            border: '1px solid #CED0D4',
            fontSize: 14,
            color: '#050505',
            backgroundColor: '#F0F2F5',
            outline: 'none',
          }}
        />
        <button
          onClick={onSend}
          disabled={!canSend}
          style={{
            padding: '8px 16px',
            borderRadius: 20,
            border: 'none',
            backgroundColor: canSend ? '#1877F2' : '#E4E6EB',
            color: canSend ? '#FFFFFF' : '#BCC0C4',
            fontWeight: 600,
            fontSize: 14,
            cursor: canSend ? 'pointer' : 'default',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
