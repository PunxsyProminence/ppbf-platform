'use client';
import React from 'react';
import { SafetyBadge } from '@packages/portals/SafetyBadge';
import { handlePPBFError } from '@packages/governance/errorHandler';
import { DashboardLayout } from '@packages/portals/DashboardLayout';
import { MainNavigation } from '@packages/portals/MainNavigation';
import { exportParticipantsToCSV } from '@packages/execution/exportUtils';
import { logToContinuityLedger } from '@packages/execution/loggingService';
import { getVersionInfo } from '@packages/governance/version';

export default function AdminDashboard() {
  return (
    <DashboardLayout title="Admin Dashboard">
      <MainNavigation />
      <h1 style={{ display: 'none' }}>Admin Dashboard</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginTop: '30px' }}>
        <div style={{ border: '1px solid #ddd', padding: '24px', borderRadius: '8px' }}>
          <h3>Participants <SafetyBadge status="safe" /></h3>
          <p>Manage all participant profiles</p>
        </div>
        <div style={{ border: '1px solid #ddd', padding: '24px', borderRadius: '8px' }}>
          <h3>Coach Review Queue <SafetyBadge status="review" /></h3>
          <p>Pending reviews: 12</p>
        </div>
        <div style={{ border: '1px solid #ddd', padding: '24px', borderRadius: '8px' }}>
          <h3>Continuity Ledger <SafetyBadge status="safe" /></h3>
          <p>Recent decisions: 47</p>
        </div>
        <div style={{ border: '1px solid #ddd', padding: '24px', borderRadius: '8px' }}>
          <h3>Governance Status <SafetyBadge status="blocked" /></h3>
          <p>Layer 0 Active</p>
        </div>
      </div>

      <div style={{ marginTop: 40 }}>
        <button onClick={() => {
          try {
            // Simulate error
            throw new Error('Demo governance error for testing');
          } catch (e) {
            const result = handlePPBFError(e, 'Admin Dashboard');
            alert(result.message);
          }
        }}>
          Test Error Handler (Layer 0)
        </button>
        <button onClick={() => alert('Run .\\run-tests.ps1 locally for full suite (simulated + file checks). See QUALITY_CHECKLIST.md.')} style={{ marginLeft: 12 }}>
          Simulate Run Tests
        </button>
        <button onClick={() => {
          const demo = [{id:'p1', name:'Demo'}, {id:'p2', name:'Athlete'}];
          const csv = exportParticipantsToCSV(demo);
          logToContinuityLedger('ADMIN_EXPORT', {type:'participants_csv', count: demo.length});
          alert('Exported CSV (simulated):\n' + csv);
        }} style={{marginLeft:8}}>
          Test Export CSV (logs to Ledger)
        </button>
      </div>
      <p style={{ fontSize: '0.8rem', color: '#666', marginTop: 20 }}>Platform: {getVersionInfo().version} | {getVersionInfo().status} | {getVersionInfo().governance} (Batches: {getVersionInfo().totalBatches})</p>
    </DashboardLayout>
  );
}
