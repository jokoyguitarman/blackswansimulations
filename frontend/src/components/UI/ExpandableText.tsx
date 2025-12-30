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
        className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow mt-1 uppercase"
      >
        {isExpanded ? '[SHOW LESS]' : '[SHOW MORE]'}
      </button>
    </div>
  );
};
