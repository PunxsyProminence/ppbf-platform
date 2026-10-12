import Link from 'next/link';

import routeInventory from '@/src/server/pilot/apiRouteInventory.json';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// /admin/system (WO-N7-03, issue #1448; OD-2026-10-08-013 Q-E): what the platform is made of, read
// from what the repository says, for the platform owner (N7-03-Q1 A; OD-2026-10-08-003 R2 keeps the
// platform owner out of gym records, so nothing here reads a gym's data).
//
// A VIEW, NOT A CONTROL PLANE. Nothing on this page runs a job, calls a route or changes anything:
// it has no form and no button. Each route row is the audited inventory row
// (apiRouteInventory.json, kept honest by apiRouteInventory.convention.test.ts). Each job row is a
// workflow file in .github/workflows (this page's test fails when the list and the folder differ).
//
// NO STATUS IS CLAIMED. The app records no runtime result for any route or job, so every row says
// so (N7-03-Q2 A). A job's row links to its run history on GitHub, which is where a run's outcome
// lives. A route that exists in source is not a route known to be working.
//
// The inventory's auditor columns (confidence, missingGate, looksWrong) rate the audit, not the
// route, and are not shown: printed here they would read as a confidence figure or a flag.

interface InventoryRow {
  id: string;
  method: string;
  path: string;
  gate: string;
  rolesAdmitted: string[];
  athleteData: boolean;
  writes: boolean;
  notes: string;
}

const ROUTES = routeInventory as InventoryRow[];

type Trigger = 'schedule' | 'manual' | 'pull request' | 'push';

interface SystemJob {
  file: string;
  name: string;
  purpose: string;
  runsOn: readonly Trigger[];
}

// One row per workflow file, in folder order. `purpose` is the file's own header, shortened.
const SYSTEM_JOBS: readonly SystemJob[] = [
  { file: 'apply-migrations.yml', name: 'apply-migrations', purpose: 'Applies database migrations.', runsOn: ['manual'] },
  { file: 'approve-library-baseline.yml', name: 'approve-library-baseline', purpose: "Clears the SHADOW evidence review gate for one organization's library.", runsOn: ['manual'] },
  { file: 'azure-static-web-apps-purple-bush-04c73e010.yml', name: 'legacy-static-web-apps-manual', purpose: 'Legacy Azure Static Web Apps deployment.', runsOn: ['manual'] },
  { file: 'backup.yml', name: 'backup', purpose: 'Backs up the pilot schema.', runsOn: ['schedule', 'manual'] },
  { file: 'branch-cleanup.yml', name: 'branch-cleanup', purpose: 'Deletes a pasted list of branches. Never main.', runsOn: ['manual'] },
  { file: 'check-database.yml', name: 'check-database', purpose: 'Read-only database diagnostics.', runsOn: ['manual'] },
  { file: 'ci.yml', name: 'ci', purpose: 'Typecheck, lint, tests and build for pull requests and main.', runsOn: ['pull request', 'push', 'manual'] },
  { file: 'cleanup-membership-orphans.yml', name: 'cleanup-membership-orphans', purpose: 'One-off cleanup of orphaned memberships.', runsOn: ['manual'] },
  { file: 'deploy-production.yml', name: 'deploy-production', purpose: 'Production deployment, schema before code.', runsOn: ['manual'] },
  { file: 'deploy-staging.yml', name: 'deploy-staging', purpose: 'Staging deployment.', runsOn: ['manual'] },
  { file: 'evidence-corpus.yml', name: 'evidence-corpus', purpose: "Checks the SHADOW evidence corpus against its published tier spec.", runsOn: ['pull request', 'push', 'manual'] },
  { file: 'import-shadow-research.yml', name: 'import-shadow-research', purpose: 'Imports the SHADOW research corpus.', runsOn: ['manual'] },
  { file: 'load-licensed-excerpts.yml', name: 'load-licensed-excerpts', purpose: 'Loads licensed research excerpts into the SHADOW Library.', runsOn: ['manual'] },
  { file: 'merged-main-e2e.yml', name: 'merged-main-e2e', purpose: 'Runs the Playwright suites against merged main.', runsOn: ['manual', 'schedule'] },
  { file: 'migration-declaration.yml', name: 'migration-declaration', purpose: "Grades a pull request body's declarations.", runsOn: ['pull request'] },
  { file: 'move-policy-shelf.yml', name: 'move-policy-shelf', purpose: "Moves one organization's policy shelf to another organization.", runsOn: ['manual'] },
  { file: 'package-integrity.yml', name: 'package-integrity', purpose: 'Checks the package manifest and lockfile.', runsOn: ['pull request', 'push', 'manual'] },
  { file: 'pre-release-migrations.yml', name: 'pre-release-migrations', purpose: 'Pre-release migration check, run before apply-migrations.', runsOn: ['manual', 'schedule'] },
  { file: 'release-one-approval.yml', name: 'release-one-approval', purpose: 'Staging, migrations and production for one commit, under one approval.', runsOn: ['manual'] },
  { file: 'repair-research-baseline.yml', name: 'repair-research-baseline', purpose: 'Repairs the platform SHADOW research baseline.', runsOn: ['manual'] },
  { file: 'rescope-library-baseline.yml', name: 'rescope-library-baseline', purpose: "Moves an imported research corpus off a gym's shelf onto the platform baseline.", runsOn: ['manual'] },
  { file: 'research-bridge-ci.yml', name: 'research-bridge-ci', purpose: 'Typecheck, tests and build for the research bridge.', runsOn: ['pull request', 'push', 'manual'] },
  { file: 'retention-cleanup.yml', name: 'retention-cleanup', purpose: 'Enforces the data retention policy.', runsOn: ['schedule', 'manual'] },
  { file: 'run-checks.yml', name: 'run-checks', purpose: 'Read-only database checks.', runsOn: ['manual'] },
  { file: 'seed-reference-data.yml', name: 'seed-reference-data', purpose: 'Loads committed reference data.', runsOn: ['manual'] },
  { file: 'session-autoclose.yml', name: 'session-autoclose', purpose: 'Closes training sessions nobody checked out of.', runsOn: ['schedule', 'manual'] },
  { file: 'session-token-cleanup.yml', name: 'session-token-cleanup', purpose: 'Cleans up expired and revoked sign-in session tokens.', runsOn: ['schedule', 'manual'] },
];

// Scripts that exist but that no workflow runs (.github/workflows/evidence-corpus.yml says so). Any
// result they left was from a hand run, so they are listed apart and never as scheduled.
const HAND_RUN_SCRIPTS: readonly { script: string; purpose: string }[] = [
  { script: 'verify-research-citations.mjs', purpose: 'Checks research citations against their sources.' },
  { script: 'check-source-retractions.mjs', purpose: 'Checks sources for retractions.' },
];

const ACTIONS_URL = 'https://github.com/PunxsyProminence/ppbf-platform/actions/workflows';

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

export default async function AdminSystemPage() {
  await requirePageRole(['platform_owner']);

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Platform Desk</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>System</h1>
          <p className="t-body mt-[var(--s3)] max-w-4xl">
            The routes and jobs the platform is built from, as the repository lists them. The app records
            no run results, so no row here says a route or job is working. A job&apos;s runs are on GitHub.
          </p>
          <div className="mt-[var(--s4)]">
            <Link href="/admin/platform" className="btn btn--ghost">Platform Desk</Link>
          </div>
        </header>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-jobs">
          <h2 id="system-jobs" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Jobs ({SYSTEM_JOBS.length})</h2>
          <table className="ledger mt-[var(--s3)]">
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">What it does</th>
                <th scope="col">Runs on</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {SYSTEM_JOBS.map((job) => (
                <tr key={job.file}>
                  <td>{job.name}<br />{job.file}</td>
                  <td>{job.purpose}</td>
                  <td>{job.runsOn.join(', ')}</td>
                  <td>
                    Status unavailable.{' '}
                    <a href={`${ACTIONS_URL}/${job.file}`} className="underline" rel="noreferrer" target="_blank">
                      Runs on GitHub
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="t-command mt-[var(--s5)]" style={{ fontSize: 'var(--t-md)' }}>Scripts no workflow runs</h3>
          <ul className="t-body mt-[var(--s2)] space-y-[var(--s2)]" aria-label="Scripts no workflow runs">
            {HAND_RUN_SCRIPTS.map((item) => (
              <li key={item.script}>
                {item.script}: {item.purpose} No workflow runs this.
              </li>
            ))}
          </ul>
        </section>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-routes">
          <h2 id="system-routes" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Routes ({ROUTES.length})</h2>
          <p className="t-body mt-[var(--s2)]">From the audited route inventory. In source; no runtime status is recorded for any route.</p>
          <table className="ledger mt-[var(--s3)]">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col">Gate</th>
                <th scope="col">Roles admitted</th>
                <th scope="col">Writes</th>
                <th scope="col">Athlete data</th>
                <th scope="col">What it does</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((route) => (
                <tr key={route.id}>
                  <td>{route.method} {route.path}</td>
                  <td>{route.gate}</td>
                  <td>{route.rolesAdmitted.length > 0 ? route.rolesAdmitted.join(', ') : 'None listed'}</td>
                  <td>{yesNo(route.writes)}</td>
                  <td>{yesNo(route.athleteData)}</td>
                  <td>{route.notes}</td>
                  <td>No runtime status recorded</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
