import { useParams, useNavigate } from 'react-router-dom';
import { ChatInterface } from '../Chat/ChatInterface';

export default function GroupChatApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: '#0B141A' }}>
      {/* WhatsApp-style header */}
      <div
        className="flex items-center gap-3 px-4"
        style={{ height: 48, backgroundColor: '#1F2C34', borderBottom: '0.5px solid #2A3942' }}
      >
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="flex items-center gap-1 ios-btn-bounce"
          style={{ color: '#00A884' }}
        >
          <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
            <path
              d="M9 1L2 8l7 7"
              stroke="#00A884"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ backgroundColor: '#25D366' }}
        >
          <span className="text-white text-[14px]">💬</span>
        </div>
        <div className="flex-1">
          <span className="font-semibold text-[16px]" style={{ color: '#E9EDEF' }}>
            TeamChat
          </span>
          <p className="text-[12px]" style={{ color: '#8696A0' }}>
            Crisis Response Group
          </p>
        </div>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#AEBAC1"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </div>
      <div className="flex-1 overflow-hidden">
        {sessionId && <ChatInterface sessionId={sessionId} />}
      </div>
    </div>
  );
}
