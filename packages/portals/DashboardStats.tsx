'use client';
import React from 'react';

export function DashboardStats() {
  // In production: fetch real metrics
  const stats = {
    totalParticipants: 52,
    activeRoutes: 38,
    pendingReviews: 12,
    safetyScore: '100%',
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
      {Object.entries(stats).map(([key, value]) => (
        <div key={key} style={{ border: '1px solid #ddd', padding: '20px', borderRadius: '8px' }}>
          <div style={{ fontSize: '0.9rem', color: '#666' }}>{key}</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', marginTop: '8px' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}
