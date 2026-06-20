'use client';
import React from 'react';

export default function GovernanceAudit() {
  const auditItems = [
    { name: 'PPBF_CAPABILITIES.json', status: 'ACTIVE', lastPromoted: '2026-06-17' },
    { name: 'Safety Gate Matrix', status: 'ACTIVE', lastPromoted: '2026-06-17' },
    { name: 'Continuity Ledger', status: 'ACTIVE', lastPromoted: '2026-06-17' },
    { name: 'Coach Review Queue', status: 'REVIEW_REQUIRED', lastPromoted: '2026-06-17' },
    { name: 'Payment Service', status: 'DRAFT', lastPromoted: 'N/A' },
  ];

  return (
    <div style={{ padding: '40px', maxWidth: '900px', margin: '0 auto' }}>
      <h1>Layer 0 Governance Audit Tool</h1>
      <p>Current status of all capabilities and components. Only ACTIVE items are production-ready.</p>

      <table style={{ width: '100%', marginTop: '30px', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#111', color: 'white' }}>
            <th style={{ padding: '12px', textAlign: 'left' }}>Component</th>
            <th style={{ padding: '12px' }}>Status</th>
            <th style={{ padding: '12px' }}>Last Promoted</th>
          </tr>
        </thead>
        <tbody>
          {auditItems.map((item, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #ddd' }}>
              <td style={{ padding: '12px' }}>{item.name}</td>
              <td style={{ padding: '12px', color: item.status === 'ACTIVE' ? 'green' : item.status === 'DRAFT' ? 'orange' : '#c00' }}>
                {item.status}
              </td>
              <td style={{ padding: '12px' }}>{item.lastPromoted}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: '30px', color: '#c00' }}>
        Only components with ACTIVE status and Jason approval may be used in production.
      </p>
    </div>
  );
}
