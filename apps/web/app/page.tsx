'use client';
import { useState } from 'react';
import { generateRoute, ALL_LIFECYCLE_TAGS, ALL_TASK_DIMENSIONS } from '@packages/routing/routeFactory';
import { isFeatureEnabled, getEnabledCapabilities } from '@packages/governance/featureFlags';
import { MainNavigation } from '@packages/portals/MainNavigation';
import { getVersionInfo } from '@packages/governance/version';

export default function PPBFPortal() {
  const [route, setRoute] = useState<any>(null);

  const handleGenerate = () => {
    const newRoute = generateRoute({
      goal: 'Improve emotional regulation',
      participantType: 'Youth',
      lifecycleTag: ALL_LIFECYCLE_TAGS[0],
      taskDimension: ALL_TASK_DIMENSIONS[0],
    });
    setRoute(newRoute);
  };

  return (
    <div>
      <MainNavigation />
      <h1>PPBF Athlete Portal</h1>
      <p>Feature flags & routing matrix active. See DEVELOPER_ONBOARDING.md for contributors.</p>
      <p style={{ fontSize: '0.9em', color: '#666' }}>
        Example flag check (Cap 4): {isFeatureEnabled(4) ? 'ENABLED' : 'draft (gated)'} | Active caps: {getEnabledCapabilities().length}
      </p>
      <p style={{ fontSize: '0.75rem', color: '#888' }}>Version: {getVersionInfo().version} | {getVersionInfo().status} | {getVersionInfo().governance} (Batch {getVersionInfo().totalBatches})</p>
      
      <button onClick={handleGenerate} style={{ padding: '12px 24px', margin: '20px 0' }}>
        Generate Development Route
      </button>

      {route && (
        <pre style={{ background: '#f5f5f5', padding: '20px', borderRadius: '8px' }}>
          {JSON.stringify(route, null, 2)}
        </pre>
      )}

      <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid #ddd' }}>
        <strong>Other governed portals:</strong><br />
        <a href="/reports">Reports</a> | <a href="/brand">Brand</a> | <a href="/ledger">Ledger</a> | <a href="/continuity">Continuity</a> | <a href="/payment">Payment (Gated)</a> | <a href="/audit">Governance Audit</a> | <a href="/migration">Legacy Migration</a> | <a href="/launch">Launch</a><br />
        <a href="/public">Public Portal</a> | <a href="/admin">Admin Dashboard</a> | <a href="/athlete">Athlete Portal</a> | <a href="/athlete/dashboard">Athlete Dashboard</a> | <a href="/guardian">Guardian Portal</a> | <a href="/readiness">Readiness</a>
        <br /><small>Developer resources: DEVELOPER_ONBOARDING.md | API_DOCS.md | run-tests.ps1 | QUALITY_CHECKLIST.md | master-runner.ps1 | ultimate-summary.ps1 | backup-export.ps1 | PROJECT_COMPLETE.md | quick-reference.ps1 | COMPLETE_REFERENCE_GUIDE.md | final-master-status.ps1 | ALL_SCRIPTS_SUMMARY.md | FINAL_RECOMMENDATIONS.md | health-check.ps1 | ppbf-cli.ps1 (in root) — Batch 19</small>
      </div>
    </div>
  );
}
