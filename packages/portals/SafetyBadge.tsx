'use client';
import React from 'react';

interface SafetyBadgeProps {
  status: 'safe' | 'review' | 'blocked';
}

export function SafetyBadge({ status }: SafetyBadgeProps) {
  const colors = {
    safe: '#22c55e',
    review: '#eab308',
    blocked: '#ef4444',
  };

  return (
    <span style={{
      background: colors[status],
      color: 'white',
      padding: '4px 12px',
      borderRadius: '9999px',
      fontSize: '0.875rem',
      fontWeight: 600,
    }}>
      {status.toUpperCase()}
    </span>
  );
}
