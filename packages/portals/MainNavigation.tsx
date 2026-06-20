'use client';
import React from 'react';

export function MainNavigation() {
  const links = [
    { href: '/', label: 'Home' },
    { href: '/athlete/dashboard', label: 'Athlete' },
    { href: '/coach-review', label: 'Coach Review' },
    { href: '/ledger', label: 'Continuity Ledger' },
    { href: '/reports', label: 'Reports' },
    { href: '/admin', label: 'Admin' },
  ];

  return (
    <div style={{ display: 'flex', gap: '24px', marginBottom: '40px', flexWrap: 'wrap' }}>
      {links.map((link, index) => (
        <a 
          key={index} 
          href={link.href}
          style={{ 
            padding: '8px 16px', 
            background: '#111', 
            color: 'white', 
            textDecoration: 'none',
            borderRadius: '6px',
            fontSize: '0.9rem'
          }}
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}
