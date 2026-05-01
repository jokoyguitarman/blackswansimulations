import { useParams, useNavigate } from 'react-router-dom';
import { ChatInterface } from '../Chat/ChatInterface';

export default function GroupChatApp() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-green-900/30">
        <button
          onClick={() => navigate(`/sim/${sessionId}/device/home`)}
          className="text-green-400 text-sm"
        >
          ← Home
        </button>
        <span className="font-bold text-green-100">TeamChat</span>
      </div>
      <div className="flex-1 overflow-hidden">
        {sessionId && <ChatInterface sessionId={sessionId} />}
      </div>
    </div>
  );
}
