'use client';
import { SafetyBadge } from '@packages/portals/SafetyBadge';

export default function PublicPortal() {
  return (
    <div style={{ padding: '60px 40px', maxWidth: '900px', margin: '0 auto', textAlign: 'center' }}>
      <h1>PPBF – Performance Preparation Build Foundation</h1>
      <p style={{ fontSize: '1.2rem', margin: '20px 0' }}>
        A nonprofit, safety-first platform using boxing to build neurological, behavioral, tactical, 
        emotional-regulation, and military-prep capabilities.
      </p>
      <div style={{ margin: '20px 0' }}>
        Current Status: <SafetyBadge status="safe" />
      </div>
      <div style={{ marginTop: '40px' }}>
        <button style={{ padding: '14px 32px', marginRight: '16px' }}>Get Started</button>
        <button style={{ padding: '14px 32px' }}>Learn More</button>
      </div>
    </div>
  );
}
