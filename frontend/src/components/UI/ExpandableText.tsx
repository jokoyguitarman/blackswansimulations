import { useState } from 'react';

interface ExpandableTextProps {
  text: string;
  maxLines?: number;
  className?: string;
}

/**
 * ExpandableText Component - Shows truncated text with expand/collapse functionality
 */
export const ExpandableText = ({ text, maxLines = 2, className = '' }: ExpandableTextProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if text needs truncation (rough estimate)
  const needsTruncation = text.length > 100; // Simple heuristic

  if (!needsTruncation) {
    return <p className={className}>{text}</p>;
  }

  return (
    <div>
      <p
        className={className}
        style={
          isExpanded
            ? {}
            : {
                WebkitLineClamp: maxLines,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="text-xs font-semibold text-brand hover:text-accent mt-1"
      >
        {isExpanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
};
