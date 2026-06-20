'use client';
import React from 'react';

interface DashboardLayoutProps {
  title: string;
  children: React.ReactNode;
  showGovernanceBanner?: boolean;
}

export function DashboardLayout({ title, children, showGovernanceBanner = true }: DashboardLayoutProps) {
  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fa' }}>
      <nav style={{ 
        background: '#111', 
        color: 'white', 
        padding: '16px 40px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <strong>PPBF</strong> Platform
        </div>
        <div style={{ fontSize: '0.9rem' }}>
          Governed by Layer 0
        </div>
      </nav>

      {showGovernanceBanner && (
        <div style={{ 
          background: '#fefce8', 
          padding: '8px 40px', 
          fontSize: '0.875rem',
          borderBottom: '1px solid #fde047'
        }}>
          All actions are logged. Jason approval required for production changes.
        </div>
      )}

      <div style={{ padding: '40px' }}>
        <h1 style={{ marginBottom: '30px' }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}
