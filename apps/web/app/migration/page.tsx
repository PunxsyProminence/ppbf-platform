'use client';
import React, { useState } from 'react';
import { migrateFromSheets, migrateFromAppsScript } from '@packages/execution/migration/legacyMigration';
import { runAIWithRefusal } from '@packages/intelligence/aiRefusalEngine';
import { enforceBoundedContext } from '@packages/governance/boundedContext';

export default function MigrationTool() {
  const [result, setResult] = useState<any>(null);

  const runMigration = () => {
    const demoData = [
      { source: 'Google Sheets', participantName: 'Demo Athlete', data: { participantType: 'Youth' } },
      { source: 'Apps Script', participantName: 'Elite Pro', data: { participantType: 'Elite/Pro-Grade' } },
    ];
    const res = migrateFromSheets(demoData);
    setResult(res);
  };

  const runAppsScriptMigration = () => {
    const res = migrateFromAppsScript({ legacyFolder: 'system_control/pending/roster' });
    setResult(res);
  };

  const testAIRefusal = () => {
    const res = runAIWithRefusal({
      type: 'youth_sparring_recommendation',  // triggers hard refusal
      participantType: 'Youth',
      input: { goal: 'sparring practice' },
    });
    setResult(res);
  };

  const testBounded = () => {
    const res1 = enforceBoundedContext('nonprofit', 'athlete_data');
    const res2 = enforceBoundedContext('personal_projects', 'athlete_data');
    setResult({ nonprofit: res1, personal: res2 });
  };

  return (
    <div style={{ padding: '40px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Legacy Data Migration Tool</h1>
      <p>Migrate from Google Sheets, Apps Script, or legacy folders into the governed system.</p>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', margin: '20px 0' }}>
        <button onClick={runMigration} style={{ padding: '14px 28px' }}>
          Run Demo Migration (Sheets)
        </button>
        <button onClick={runAppsScriptMigration} style={{ padding: '14px 28px' }}>
          Run Apps Script Migration
        </button>
        <button onClick={testAIRefusal} style={{ padding: '14px 28px' }}>
          Test AI Refusal (Youth + contact)
        </button>
        <button onClick={testBounded} style={{ padding: '14px 28px' }}>
          Test Bounded Context
        </button>
      </div>

      {result && (
        <pre style={{ background: '#f5f5f5', padding: '20px', borderRadius: '8px', overflowX: 'auto' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}

      <p style={{ color: '#c00' }}>All migrated data requires Jason approval before becoming ACTIVE. AI refusals and context isolation are enforced (Layer 0).</p>
    </div>
  );
}
