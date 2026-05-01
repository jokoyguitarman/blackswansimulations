import { useState, useEffect } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';

export default function DeviceShell() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      {/* Phone Frame */}
      <div className="relative w-[390px] h-[844px] bg-black rounded-[50px] shadow-2xl border-4 border-gray-700 overflow-hidden flex flex-col">
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120px] h-[30px] bg-black rounded-b-2xl z-50" />

        {/* Status Bar */}
        <div className="h-[50px] bg-gray-950 flex items-end justify-between px-8 pb-1 text-white text-xs font-medium z-40">
          <span>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="flex items-center gap-1">
            <span className="text-[10px]">5G</span>
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2 22h20V2z" opacity="0.3" />
              <path d="M12 12L2 22h20V2z" />
            </svg>
            <span>87%</span>
          </div>
        </div>

        {/* Screen Content */}
        <div className="flex-1 overflow-hidden bg-white dark:bg-gray-950">
          <Outlet />
        </div>

        {/* Home Indicator */}
        <div className="h-[34px] bg-gray-950 flex items-center justify-center">
          <button
            onClick={() => navigate(`/sim/${sessionId}/device/home`)}
            className="w-[134px] h-[5px] bg-gray-400 rounded-full hover:bg-gray-300 transition-colors"
          />
        </div>
      </div>
    </div>
  );
}
