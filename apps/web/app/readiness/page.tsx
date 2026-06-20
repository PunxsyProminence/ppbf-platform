'use client';
import React, { useState } from 'react';
import { SafetyBadge } from '@packages/portals/SafetyBadge';

const readinessChecklist = [
  "Hydration & nutrition logged",
  "Sleep quality 7+ hrs or adjusted",
  "No active injury flags",
  "Emotional baseline self-rated",
  "Equipment & space safe",
];

export default function ReadinessPage() {
  const [checks, setChecks] = useState<Record<number, boolean>>({});

  const toggle = (idx: number) => {
    setChecks(c => ({ ...c, [idx]: !c[idx] }));
  };

  const allReady = readinessChecklist.every((_, i) => checks[i]);
  const readyCount = Object.values(checks).filter(Boolean).length;

  return (
    <div style={{ padding: 40 }}>
      <h1>PPBF Readiness & Recovery Assessment</h1>
      <p>Capability #7 (Program lane) + Task Dimension: Recovery & Readiness Assessment</p>

      <div className="card">
        <h2>Pre-Session Safety & Readiness Checklist (Cap #11 Safety Gate)</h2>
        {readinessChecklist.map((item, idx) => (
          <label key={idx} className="checkbox-container" style={{ display: 'block', margin: '10px 0' }}>
            <input type="checkbox" checked={!!checks[idx]} onChange={() => toggle(idx)} /> {item}
          </label>
        ))}
        <div style={{ marginTop: 16 }}>
          Readiness: {readyCount} / {readinessChecklist.length}
          {allReady && <SafetyBadge status="safe" />}
          {!allReady && <SafetyBadge status="review" />}
        </div>
        {!allReady && <div style={{ color: '#c53030', marginTop: 8 }}>Complete all items before proceeding. Safety gate enforced.</div>}
      </div>

      <a href="/">← Back</a>
    </div>
  );
}
