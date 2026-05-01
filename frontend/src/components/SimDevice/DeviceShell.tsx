import { useState, useEffect } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';
import '../../styles/device-sim.css';

export default function DeviceShell() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const hours = time.getHours();
  const minutes = time.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  return (
    <div className="min-h-screen bg-[#1a1a2e] flex items-center justify-center p-4 device-sim">
      <div className="relative" style={{ width: 393, height: 852 }}>
        {/* Phone Frame */}
        <svg
          width="430"
          height="882"
          viewBox="0 0 430 882"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ position: 'absolute', top: -15, left: -18.5, pointerEvents: 'none' }}
        >
          {/* Body */}
          <path
            d="M2 73C2 32.68 34.68 0 75 0H357C397.32 0 430 32.68 430 73V809C430 849.32 397.32 882 357 882H75C34.68 882 2 849.32 2 809V73Z"
            fill="#404040"
          />
          {/* Volume buttons */}
          <path
            d="M0 171C0 170.45 0.45 170 1 170H3V204H1C0.45 204 0 203.55 0 203V171Z"
            fill="#4a4a4a"
          />
          <path
            d="M1 234C1 233.45 1.45 233 2 233H3.5V300H2C1.45 300 1 299.55 1 299V234Z"
            fill="#4a4a4a"
          />
          <path
            d="M1 319C1 318.45 1.45 318 2 318H3.5V385H2C1.45 385 1 384.55 1 384V319Z"
            fill="#4a4a4a"
          />
          {/* Power button */}
          <path
            d="M430 279H432C432.55 279 433 279.45 433 280V384C433 384.55 432.55 385 432 385H430V279Z"
            fill="#4a4a4a"
          />
          {/* Inner bezel */}
          <path
            d="M6 74C6 35.34 37.34 4 76 4H356C394.66 4 426 35.34 426 74V808C426 846.66 394.66 878 356 878H76C37.34 878 6 846.66 6 808V74Z"
            fill="#1C1C1E"
          />
          {/* Screen border */}
          <rect x="21" y="19" width="390" height="844" rx="55" ry="55" fill="#000000" />
          {/* Dynamic Island */}
          <path
            d="M154 48.5C154 38.28 162.28 30 172.5 30H259.5C269.72 30 278 38.28 278 48.5C278 58.72 269.72 67 259.5 67H172.5C162.28 67 154 58.72 154 48.5Z"
            fill="#1C1C1E"
          />
          {/* Camera lens */}
          <circle cx="259.5" cy="48.5" r="5.5" fill="#2C2C2E" />
          <circle cx="259.5" cy="48.5" r="3.5" fill="#1C1C1E" />
        </svg>

        {/* Screen Content Area */}
        <div
          className="absolute overflow-hidden bg-black"
          style={{
            top: 0,
            left: 0,
            width: 393,
            height: 852,
            borderRadius: 47,
            clipPath: 'inset(0 round 47px)',
          }}
        >
          {/* Status Bar */}
          <div
            className="ios-status-bar relative z-50 flex items-center justify-between px-8 text-white"
            style={{ height: 54, paddingTop: 14 }}
          >
            <span className="text-[15px] font-semibold tracking-tight">{timeStr}</span>
            <div className="flex items-center gap-[5px]">
              {/* Signal bars */}
              <svg width="17" height="12" viewBox="0 0 17 12" fill="white">
                <rect x="0" y="9" width="3" height="3" rx="0.5" opacity="1" />
                <rect x="4.5" y="6" width="3" height="6" rx="0.5" opacity="1" />
                <rect x="9" y="3" width="3" height="9" rx="0.5" opacity="1" />
                <rect x="13.5" y="0" width="3" height="12" rx="0.5" opacity="0.3" />
              </svg>
              <span className="text-[12px] font-semibold ml-0.5">5G</span>
              {/* WiFi */}
              <svg width="16" height="12" viewBox="0 0 16 12" fill="white" className="ml-0.5">
                <path d="M8 11.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                <path
                  d="M4.05 7.95a5.5 5.5 0 017.9 0"
                  stroke="white"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
                <path
                  d="M1.3 5.2a9 9 0 0113.4 0"
                  stroke="white"
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
              {/* Battery */}
              <svg width="27" height="13" viewBox="0 0 27 13" className="ml-1">
                <rect
                  x="0"
                  y="0.5"
                  width="23"
                  height="12"
                  rx="3.5"
                  stroke="white"
                  strokeOpacity="0.35"
                  fill="none"
                />
                <rect x="1.5" y="2" width="17" height="9" rx="2" fill="#34C759" />
                <path
                  d="M24 4.5C25.1 4.5 26 5.4 26 6.5C26 7.6 25.1 8.5 24 8.5V4.5Z"
                  fill="white"
                  fillOpacity="0.4"
                />
              </svg>
            </div>
          </div>

          {/* App Content */}
          <div className="flex-1 overflow-hidden" style={{ height: 852 - 54 - 34 }}>
            <Outlet />
          </div>

          {/* Home Indicator */}
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center justify-center"
            style={{ height: 34 }}
          >
            <button
              onClick={() => navigate(`/sim/${sessionId}/device/home`)}
              className="rounded-full bg-white/30 hover:bg-white/50 transition-colors"
              style={{ width: 134, height: 5 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
