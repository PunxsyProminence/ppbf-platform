'use client';
import React from 'react';
import { brandAssets, getApprovedAssets, trackPhotoConsent, BrandAsset } from '@packages/portals/brand/brandManager';

export default function BrandPage() {
  const approved = getApprovedAssets();

  const handleConsent = (assetId: string) => {
    const consent = trackPhotoConsent('P-DEMO-001', assetId);
    alert('Consent logged: ' + JSON.stringify(consent, null, 2) + '\n\nGoverned by Continuity Ledger (cap #22)');
  };

  return (
    <div style={{ padding: 40 }}>
      <h1>PPBF Creative &amp; Brand Asset Manager</h1>
      <p>Capability #17 — All assets respect safety/consent (Layer 0)</p>

      <div className="card">
        <h2>Approved Assets</h2>
        {approved.map((a: BrandAsset) => (
          <div key={a.id} style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>
            <strong>{a.name}</strong> ({a.type}) — {a.consentTracking ? 'Consent Tracked' : 'Consent Pending'}
            <button style={{ marginLeft: 12 }} onClick={() => handleConsent(a.id)}>Log Consent</button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>All Brand Assets</h2>
        <ul>
          {brandAssets.map(a => <li key={a.id}>{a.name} — approved: {a.approved ? 'yes' : 'no'}</li>)}
        </ul>
      </div>
      <a href="/">← Back to Portal Home</a>
    </div>
  );
}
