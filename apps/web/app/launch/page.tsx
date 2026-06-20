'use client';

import React from 'react';
import { DashboardLayout } from '@packages/portals/DashboardLayout';
import { MainNavigation } from '@packages/portals/MainNavigation';
import { getVersionInfo } from '@packages/governance/version';

export default function LaunchPortal() {
  return (
    <DashboardLayout title="PPBF Launch Portal">
      <MainNavigation />
      <p>
        <strong>Production Go-Live Center</strong> — Capability overview and final launch gate.
      </p>

      <div style={{ margin: '30px 0', padding: 20, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }}>
        <h3>Go-Live Status</h3>
        <ul>
          <li>✅ 25 Capabilities defined</li>
          <li>✅ Routing Matrix + Safety Gates active</li>
          <li>✅ All stakeholder portals deployed</li>
          <li>⏳ Supabase production connection</li>
          <li>⏳ Jason approval for remaining DRAFT items</li>
          <li>⏳ Bounded context verification</li>
          <li>Run <code>.\master-runner.ps1</code> or <code>.\ultimate-summary.ps1</code> (or the individual scripts including backup-export.ps1) before deploy</li>
          <li>Run <code>.\backup-export.ps1</code> regularly to protect your governed data</li>
          <li>Review DEVELOPER_ONBOARDING.md, FINAL_SUMMARY.md, PROJECT_COMPLETE.md and COMPLETE_REFERENCE_GUIDE.md</li>
          <li>Follow QUALITY_CHECKLIST.md for all contributions</li>
          <li>Run <code>.\quick-reference.ps1</code> and <code>.\final-master-status.ps1</code> for daily reference and status (Batch 16)</li>
          <li>See ALL_SCRIPTS_SUMMARY.md and FINAL_RECOMMENDATIONS.md for full catalog and roadmap (Batch 18)</li>
          <li>Batch 19: health-check.ps1, version.ts, ppbf-cli.ps1</li>
        </ul>
      </div>

      <div style={{ marginTop: 30 }}>
        <h3>Next Steps</h3>
        <ol>
          <li>Run <code>.\master-runner.ps1</code> (recommended) or the individual scripts</li>
          <li>Apply Supabase schema</li>
          <li>Promote all components to ACTIVE (requires Jason)</li>
          <li>Verify Continuity Ledger and Safety Refusals</li>
          <li>Review ALL_SCRIPTS_SUMMARY.md and FINAL_RECOMMENDATIONS.md</li>
          <li>Try ppbf-cli.ps1 (e.g. health, status, golive) or ppbf-cli.ps1 all</li>
          <li>Run health-check.ps1 for full platform check</li>
          <li>Platform version in packages/governance/version.ts (getVersionInfo())</li>
          <li>Deploy to Vercel</li>
        </ol>
      </div>

      <div style={{ marginTop: 30 }}>
        <h3>For Developers</h3>
        <p>See <strong>DEVELOPER_ONBOARDING.md</strong>, <strong>COMPLETE_REFERENCE_GUIDE.md</strong> and <strong>API_DOCS.md</strong> in the project root.</p>
        <p>Use <code>.\quick-reference.ps1</code> and <code>.\final-master-status.ps1</code> for daily reference.</p>
        <p>Follow Layer 0 at all times. New contributors should review the full onboarding guide.</p>
        <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '8px' }}>Platform: {getVersionInfo().version} | {getVersionInfo().status} | {getVersionInfo().governance} (Batches: {getVersionInfo().totalBatches})</p>
        <p style={{ fontSize: '0.75rem' }}>Try: ppbf-cli.ps1 health or ppbf-cli.ps1 summary</p>
        <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '10px' }}>
          Version: {getVersionInfo().version} (Batches: {getVersionInfo().totalBatches})
        </p>
      </div>

      <p style={{ marginTop: 40, color: '#c00', fontWeight: 'bold' }}>
        Layer 0 Governance: Nothing goes live without full Jason approval.
      </p>

      <a href="/" style={{ display: 'inline-block', marginTop: 20 }}>← Back to Main Portal</a>
    </DashboardLayout>
  );
}
