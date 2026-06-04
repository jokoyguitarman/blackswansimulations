interface LinkPreviewCardProps {
  headline: string;
  outletName: string;
  snippet: string;
  category?: string;
  platform: 'facebook' | 'x_twitter' | 'chat';
  onClick?: () => void;
}

export function LinkPreviewCard({
  headline,
  outletName,
  snippet,
  category,
  platform,
  onClick,
}: LinkPreviewCardProps) {
  const isX = platform === 'x_twitter';
  const isFB = platform === 'facebook';
  const isChat = platform === 'chat';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl overflow-hidden border mt-2 ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      style={{
        borderColor: isX || isChat ? '#2F3336' : '#E4E6EB',
        backgroundColor: isX || isChat ? '#16181C' : '#F0F2F5',
      }}
    >
      {/* Top accent bar */}
      <div
        className="h-1"
        style={{
          backgroundColor: isFB ? '#1877F2' : isX ? '#1D9BF0' : '#007AFF',
        }}
      />

      <div className={`${isChat ? 'px-3 py-2' : 'px-3.5 py-3'}`}>
        {/* Outlet + category */}
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`${isChat ? 'text-[11px]' : 'text-[12px]'} font-medium`}
            style={{ color: isX || isChat ? '#71767B' : '#65676B' }}
          >
            {outletName}
          </span>
          {category && (
            <span
              className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded"
              style={{
                backgroundColor:
                  category === 'breaking'
                    ? '#FF3B30'
                    : category === 'analysis'
                      ? '#5856D6'
                      : '#FF9500',
                color: '#FFFFFF',
              }}
            >
              {category}
            </span>
          )}
        </div>

        {/* Headline */}
        <p
          className={`${isChat ? 'text-[13px]' : 'text-[14px]'} font-semibold leading-tight ${isChat ? 'line-clamp-2' : 'line-clamp-3'}`}
          style={{ color: isX || isChat ? '#E7E9EA' : '#050505' }}
        >
          {headline}
        </p>

        {/* Snippet */}
        {snippet && !isChat && (
          <p
            className="text-[12px] mt-1 line-clamp-2"
            style={{ color: isX ? '#71767B' : '#65676B' }}
          >
            {snippet}
          </p>
        )}

        {/* Domain link */}
        <div className="flex items-center gap-1 mt-1.5">
          <svg
            width={isChat ? 10 : 12}
            height={isChat ? 10 : 12}
            viewBox="0 0 24 24"
            fill="none"
            stroke={isX || isChat ? '#71767B' : '#65676B'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span
            className={`${isChat ? 'text-[10px]' : 'text-[11px]'}`}
            style={{ color: isX || isChat ? '#71767B' : '#65676B' }}
          >
            news.sim
          </span>
        </div>
      </div>
    </button>
  );
}
