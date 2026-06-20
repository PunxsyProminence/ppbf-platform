'use client';
import React from 'react';

interface NotificationBannerProps {
  message: string;
  type?: 'info' | 'success' | 'warning';
}

export function NotificationBanner({ message, type = 'info' }: NotificationBannerProps) {
  const colors = {
    info: '#3b82f6',
    success: '#22c55e',
    warning: '#f59e0b',
  };

  return (
    <div style={{
      background: colors[type],
      color: 'white',
      padding: '12px 20px',
      borderRadius: '6px',
      marginBottom: '20px',
    }}>
      {message}
    </div>
  );
}
