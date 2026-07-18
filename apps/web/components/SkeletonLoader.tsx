import React from 'react';

interface SkeletonLoaderProps {
  /**
   * Width of the skeleton (CSS value, e.g., "100%", "200px")
   * @default "100%"
   */
  readonly width?: string;

  /**
   * Height of the skeleton (CSS value, e.g., "100%", "20px")
   * @default "20px"
   */
  readonly height?: string;

  /**
   * Number of lines to render
   * @default 1
   */
  readonly lines?: number;

  /**
   * Gap between lines (CSS value, e.g., "8px", "1rem")
   * @default "8px"
   */
  readonly gap?: string;

  /**
   * Border radius (CSS value, e.g., "4px", "8px")
   * @default "4px"
   */
  readonly borderRadius?: string;

  /**
   * Show circular skeleton (ignores height)
   * @default false
   */
  readonly isCircle?: boolean;

  /**
   * Disable animation (static skeleton)
   * @default false
   */
  readonly disableAnimation?: boolean;

  /**
   * Custom CSS class for styling
   */
  readonly className?: string;
}

/**
 * SkeletonLoader: Placeholder shimmer animation component
 * Used to show loading state while fetching data
 *
 * @example
 * // Simple single-line skeleton
 * <SkeletonLoader width="100%" height="20px" />
 *
 * @example
 * // Multi-line paragraph skeleton
 * <SkeletonLoader width="100%" height="14px" lines={4} gap="8px" />
 *
 * @example
 * // Circular skeleton (for avatars)
 * <SkeletonLoader width="40px" isCircle={true} />
 */
export default function SkeletonLoader({
  width = '100%',
  height = '20px',
  lines = 1,
  gap = '8px',
  borderRadius = '4px',
  isCircle = false,
  disableAnimation = false,
  className = '',
}: SkeletonLoaderProps): React.ReactElement {
  const skeletonStyle: React.CSSProperties = {
    width,
    height: isCircle ? width : height, // For circles, height = width
    borderRadius: isCircle ? '50%' : borderRadius,
    backgroundColor: 'var(--skeleton-bg, #e0e0e0)',
    animation: disableAnimation ? 'none' : 'shimmer 2s infinite',
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap,
  };

  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% {
            background-color: var(--skeleton-bg, #e0e0e0);
            background-image: linear-gradient(
              90deg,
              transparent,
              rgba(255, 255, 255, 0.3),
              transparent
            );
            background-size: 200% 100%;
            background-position: -200% 0;
          }
          100% {
            background-color: var(--skeleton-bg, #e0e0e0);
            background-image: linear-gradient(
              90deg,
              transparent,
              rgba(255, 255, 255, 0.3),
              transparent
            );
            background-size: 200% 100%;
            background-position: 200% 0;
          }
        }
      `}</style>

      <div style={containerStyle} className={className}>
        {Array.from({ length: lines }).map((_, index) => ({
          id: `skeleton-line-${index}`,
          lineIndex: index,
        })).map(({ id, lineIndex }) => (
          <div
            key={id}
            style={{
              ...skeletonStyle,
              // Optional: make last line slightly narrower
              width: lineIndex === lines - 1 ? `${65 + (lineIndex % 20)}%` : width,
            }}
            aria-hidden="true"
          />
        ))}
      </div>
    </>
  );
}
