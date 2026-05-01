import { useParams, useNavigate } from 'react-router-dom';
import { ChatInterface } from '../Chat/ChatInterface';

export default function GroupChatApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0B141A' }}>
      {/* WhatsApp-style header */}
      <div
        className="flex items-center gap-3 px-3 flex-shrink-0"
        style={{
          height: 56,
          backgroundColor: '#075E54',
        }}
      >
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="flex items-center ios-btn-bounce"
        >
          <svg width="12" height="20" viewBox="0 0 12 20" fill="none">
            <path
              d="M10 2L2 10l8 8"
              stroke="#FFFFFF"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Group avatar */}
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: '#25D366' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <span className="font-semibold text-[16px] block truncate" style={{ color: '#FFFFFF' }}>
            Crisis Response Team
          </span>
          <p className="text-[12px]" style={{ color: 'rgba(255,255,255,0.7)' }}>
            8 members · 3 online
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-4">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94" />
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="12" cy="5" r="1" fill="rgba(255,255,255,0.85)" />
            <circle cx="12" cy="12" r="1" fill="rgba(255,255,255,0.85)" />
            <circle cx="12" cy="19" r="1" fill="rgba(255,255,255,0.85)" />
          </svg>
        </div>
      </div>

      {/* Chat area with wallpaper */}
      <div
        className="flex-1 overflow-hidden relative"
        style={{
          backgroundColor: '#0B141A',
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      >
        {sessionId && <ChatInterface sessionId={sessionId} />}
      </div>
    </div>
  );
}
