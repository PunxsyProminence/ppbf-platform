import type { Metadata } from 'next';
import React from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'PPBF Platform',
  description: 'Performance Preparation Build Foundation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', margin: 0, padding: 0 }}>
        <nav style={{ background: '#111', color: 'white', padding: '16px 40px' }}>
          <strong>PPBF</strong> — Nonprofit Boxing Performance Platform
        </nav>
        <main style={{ padding: '40px' }}>{children}</main>
      </body>
    </html>
  );
}
