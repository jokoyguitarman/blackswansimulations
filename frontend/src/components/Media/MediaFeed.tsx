import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useWebSocket } from '../../hooks/useWebSocket';

interface MediaPost {
  id: string;
  source: string;
  headline: string;
  content: string;
  sentiment: string;
  is_misinformation: boolean;
  created_at: string;
}

interface MediaFeedProps {
  sessionId: string;
}

export const MediaFeed = ({ sessionId }: MediaFeedProps) => {
  const [posts, setPosts] = useState<MediaPost[]>([]);
  const [loading, setLoading] = useState(true);

  // Subscribe to real-time media post updates via WebSocket
  useWebSocket({
    sessionId,
    eventTypes: ['media_post'],
    onEvent: (event) => {
      if (event.type === 'media_post' && event.data && event.data.media_id) {
        // Reload media when new post is created
        loadMedia();
      }
    },
  });

  useEffect(() => {
    // Load initial media
    loadMedia();
  }, [sessionId]);

  const loadMedia = async () => {
    try {
      const result = await api.media.list(sessionId, 1, 20);
      setPosts(result.data as MediaPost[]);
    } catch (error) {
      console.error('Failed to load media:', error);
    } finally {
      setLoading(false);
    }
  };

  const getSentimentColor = (sentiment: string) => {
    switch (sentiment) {
      case 'positive':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'negative':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      case 'critical':
        return 'bg-red-900/20 text-red-400 border-red-400';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
    }
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_MEDIA]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="military-border p-4">
        <h3 className="text-lg terminal-text uppercase">[MEDIA_FEED] News & Social Media</h3>
      </div>
      <div className="space-y-3">
        {posts.map((post) => (
          <div
            key={post.id}
            className={`military-border p-4 border-l-4 ${
              post.is_misinformation
                ? 'border-red-500 bg-red-900/10'
                : getSentimentColor(post.sentiment)
            }`}
          >
            <div className="flex justify-between items-start mb-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                    {post.source}
                  </span>
                  {post.is_misinformation && (
                    <span className="text-xs terminal-text text-red-400 px-2 py-1 bg-red-900/20 border border-red-400">
                      [MISINFORMATION]
                    </span>
                  )}
                </div>
                <h4 className="text-sm terminal-text font-semibold mb-1">{post.headline}</h4>
                <p className="text-xs terminal-text text-robotic-yellow/70 mb-2">{post.content}</p>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs terminal-text px-2 py-1 border ${getSentimentColor(post.sentiment)}`}
                  >
                    {post.sentiment.toUpperCase()}
                  </span>
                  <span className="text-xs terminal-text text-robotic-yellow/50">
                    {new Date(post.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
        {posts.length === 0 && (
          <div className="military-border p-8 text-center">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              [NO_MEDIA] No media posts yet
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
