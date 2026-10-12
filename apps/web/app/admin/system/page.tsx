import Link from 'next/link';

import routeInventory from '@/src/server/pilot/apiRouteInventory.json';
import {
  listLocalFindings,
  type LocalFindingDomain,
  type LocalFindingStatus,
  type LocalFindingTier,
} from '@/src/server/pilot/localFindings';
import { gymDayIso } from '@/src/lib/gymTime';
import { requirePageRole } from '@/src/server/pilot/pageGuard';
import { roleEquals } from '@/src/server/pilot/roleAlias';
import { getSourceCitationStatus, type SourceCitationReviewSignal } from '@/src/server/pilot/sourceCitationChecks';
import { getSourceRetractionStatus } from '@/src/server/pilot/sourceRetractionChecks';
import { buildPilotOpsReadinessReport } from '@/src/server/pilot/pilotOpsReadiness';

export const dynamic = 'force-dynamic';

// /admin/system (WO-N7-03, issue #1448; OD-2026-10-08-013 Q-E). Two audiences, each with only its
// own data (N7-03-Q1 A):
//   - the platform owner sees what the platform is made of, read from what the repository says.
//     OD-2026-10-08-003 R2 keeps the platform owner out of gym records, so that view reads none;
//   - a gym's organization admin sees that gym's local findings, citation checks and retraction
//     checks, read through the same server functions the existing GET routes call
//     (admin/local-findings, admin/citation-checks, admin/retraction-checks), for
//     principal.organizationId only. No route or job inventory is shown to a gym.
//
// A VIEW, NOT A CONTROL PLANE. Nothing on this page runs a job, calls a route or changes anything:
// the platform view has no form and no button, and the gym view's only forms are GET filters. Each route row is the route inventory row (apiRouteInventory.json).
// Its convention test re-checks the mechanical gate columns only; the writes, athlete-data and notes
// columns are a reviewer's draft reading, and the page says so. Each workflow row is a file in
// .github/workflows (this page's test fails when the list and the folder differ). The in-app worker
// is listed with the one thing known about it here: whether this deployment switches it on.
//
// NO RUN STATUS IS CLAIMED. Nothing this page may read records whether a route or job worked, so
// every row says so (N7-03-Q2 A). A workflow's row links to its run history on GitHub. A route that
// exists in source is not a route known to be working.
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

// One row per workflow file, in folder order. `purpose` is one line read from the file.
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
  { file: 'retention-cleanup.yml', name: 'retention-cleanup', purpose: "Nightly: deletes expired public enquiries and counts records due for deletion. People's records are deleted only by a manual run.", runsOn: ['schedule', 'manual'] },
  { file: 'run-checks.yml', name: 'run-checks', purpose: 'Read-only database checks.', runsOn: ['manual'] },
  { file: 'seed-reference-data.yml', name: 'seed-reference-data', purpose: 'Loads committed reference data.', runsOn: ['manual'] },
  { file: 'session-autoclose.yml', name: 'session-autoclose', purpose: 'Closes training sessions nobody checked out of.', runsOn: ['schedule', 'manual'] },
  { file: 'session-token-cleanup.yml', name: 'session-token-cleanup', purpose: 'Counts expired and revoked sign-in tokens. Deletes them on a manual run, or nightly once its repository variable is switched on.', runsOn: ['schedule', 'manual'] },
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

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdminSystemPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const principal = await requirePageRole(['platform_owner', 'organization_admin']);
  if (roleEquals(principal.role, 'platform_owner')) return <PlatformSystemView />;
  return <GymSystemView organizationId={principal.organizationId} params={(await searchParams) ?? {}} />;
}

function PlatformSystemView() {
  // Configuration only (the same report GET /api/pilot/ops/readiness gives the platform owner):
  // whether the worker is switched on, never whether a run worked.
  const workerOn = buildPilotOpsReadinessReport().shadowWorker.enabled;

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Platform Desk</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>System</h1>
          <p className="t-body mt-[var(--s3)] max-w-4xl">
            The routes and jobs the platform is built from, as the repository lists them. No row here says a
            route or job is working. A workflow&apos;s runs are on GitHub.
          </p>
          <div className="mt-[var(--s4)]">
            <Link href="/admin/platform" className="btn btn--ghost">Platform Desk</Link>
          </div>
        </header>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-jobs">
          <h2 id="system-jobs" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Jobs ({SYSTEM_JOBS.length + 1})</h2>
          <table className="ledger mt-[var(--s3)]" aria-labelledby="system-jobs">
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">What it does</th>
                <th scope="col">Trigger</th>
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
                      Run history on GitHub (new tab)
                    </a>
                  </td>
                </tr>
              ))}
              <tr>
                <td>In-app worker<br />instrumentation.ts</td>
                <td>Inside the app server: SHADOW background jobs, the video scan sweep and housekeeping.</td>
                <td>server tick</td>
                <td>
                  Status unavailable. Setting: {workerOn ? 'on' : 'off'} in this deployment.
                </td>
              </tr>
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
          <p className="t-body mt-[var(--s2)]">
            From the route inventory. Gate and roles are checked against the code by a test; writes, athlete
            data and notes are a reviewer&apos;s reading. No runtime status is recorded for any route.
          </p>
          <table className="ledger mt-[var(--s3)]" aria-labelledby="system-routes">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col">Gate</th>
                <th scope="col">Roles admitted</th>
                <th scope="col">Writes</th>
                <th scope="col">Athlete data</th>
                <th scope="col">Notes</th>
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

// ---------------------------------------------------------------------------------------------
// The gym's view. Read-only: each filter is a plain GET form that only changes the address. Every
// value is printed as stored, with its own words (underscores read as spaces); nothing is turned
// into a percentage, a confidence figure or a citation. A read that failed says so, and is never
// shown as "none".
// ---------------------------------------------------------------------------------------------

const FINDING_DOMAINS: readonly LocalFindingDomain[] = ['technical', 'physical', 'psychological', 'operational', 'safety'];
const FINDING_TIERS: readonly LocalFindingTier[] = [
  'observation', 'repeated_observation', 'local_pattern', 'local_tested', 'local_established', 'retired',
];
const FINDING_STATUSES: readonly LocalFindingStatus[] = ['active', 'superseded', 'retired'];
const CITATION_SIGNALS: readonly SourceCitationReviewSignal[] = ['needs_adjudication', 'recheck_pending', 'not_machine_checkable', 'ok'];

type Read<T> = { ok: true; rows: T[] } | { ok: false };

async function read<T>(load: () => Promise<T[]>): Promise<Read<T>> {
  try {
    return { ok: true, rows: await load() };
  } catch (error) {
    // Logged on the server so an outage or an unapplied migration is visible; the page says only
    // that the section could not be read.
    console.error('admin/system: a read failed', error);
    return { ok: false };
  }
}

/** A query value, only when it is one of the allowed words; anything else is no filter. */
function pick<T extends string>(params: SearchParams, key: string, allowed: readonly T[]): T | undefined {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return allowed.find((item) => item === value);
}

function words(value: string | null | undefined): string {
  return value ? value.replaceAll('_', ' ') : 'None recorded';
}

/** An instant (timestamptz arrives as a Date) as the gym's own calendar day. */
function gymDay(value: string | Date | null | undefined): string {
  return gymDayIso(value) ?? 'None recorded';
}

/** A `date` column, which db.ts already hands over as its YYYY-MM-DD string. */
function calendarDay(value: string | null | undefined): string {
  return value ? String(value) : 'None recorded';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${Number(count) === 1 ? one : many}`;
}

function text(value: string | null | undefined): string {
  return value && value.trim() ? value : 'None recorded';
}

function FilterSelect({ name, label, options, value }: { name: string; label: string; options: readonly string[]; value?: string }) {
  return (
    <span className="field">
      <label className="t-label" htmlFor={`filter-${name}`}>{label}</label>
      <select id={`filter-${name}`} name={name} className="select" defaultValue={value ?? ''}>
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>{words(option)}</option>
        ))}
      </select>
    </span>
  );
}

function ReadState({ result, children }: { result: Read<unknown>; children: React.ReactNode }) {
  if (!result.ok) return <p className="t-body mt-[var(--s3)]">This could not be read just now.</p>;
  if (result.rows.length === 0) return <p className="t-body mt-[var(--s3)]">None recorded.</p>;
  return <>{children}</>;
}

async function GymSystemView({ organizationId, params }: { organizationId: string; params: SearchParams }) {
  const domain = pick(params, 'domain', FINDING_DOMAINS);
  const localTier = pick(params, 'local_tier', FINDING_TIERS);
  const status = pick(params, 'status', FINDING_STATUSES);
  const reviewSignal = pick(params, 'review_signal', CITATION_SIGNALS);

  const [findings, citations, retractions] = await Promise.all([
    read(() => listLocalFindings(organizationId, { domain, localTier, status })),
    read(() => getSourceCitationStatus(organizationId, { reviewSignal })),
    read(() => getSourceRetractionStatus(organizationId)),
  ]);

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Admin Workspace</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>System</h1>
          <p className="t-body mt-[var(--s3)] max-w-4xl">
            This gym&apos;s local findings and the checks on its research sources, as recorded. Read-only.
          </p>
          <div className="mt-[var(--s4)]">
            <Link href="/admin" className="btn btn--ghost">Capability Room</Link>
          </div>
        </header>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-findings">
          <h2 id="system-findings" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Local findings</h2>
          <form method="get" action="/admin/system" className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
            <FilterSelect name="domain" label="Domain" options={FINDING_DOMAINS} value={domain} />
            <FilterSelect name="local_tier" label="Tier" options={FINDING_TIERS} value={localTier} />
            <FilterSelect name="status" label="Status" options={FINDING_STATUSES} value={status} />
            {reviewSignal && <input type="hidden" name="review_signal" value={reviewSignal} />}
            <button type="submit" className="btn btn--ghost">Show findings</button>
          </form>
          <ReadState result={findings}>
            <table className="ledger mt-[var(--s3)]" aria-labelledby="system-findings">
              <thead>
                <tr>
                  <th scope="col">Finding</th>
                  <th scope="col">Domain</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Status</th>
                  <th scope="col">Athletes observed</th>
                  <th scope="col">Prediction</th>
                  <th scope="col">Limits and other explanations</th>
                  <th scope="col">Published research</th>
                </tr>
              </thead>
              <tbody>
                {findings.ok && findings.rows.map((finding) => (
                  <tr key={finding.finding_id}>
                    <td><b>{finding.title}</b><br />{finding.statement}<br />Applies to: {text(finding.applies_to)}</td>
                    <td>{words(finding.domain)}</td>
                    <td>{words(finding.local_tier)}</td>
                    <td>{words(finding.status)}</td>
                    <td>
                      {finding.athletes_observed}, over {plural(finding.observation_span_days, 'day', 'days')}, by{' '}
                      {plural(finding.independent_observers, 'observer', 'observers')}
                    </td>
                    <td>{text(finding.prediction_statement)}<br />Outcome: {words(finding.prediction_outcome)}</td>
                    <td>
                      Known limits: {text(finding.known_limitations)}<br />
                      Other explanations: {text(finding.competing_explanations)}
                    </td>
                    <td>
                      {words(finding.agrees_with_literature)}
                      {finding.contradiction_note ? <><br />{finding.contradiction_note}</> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ReadState>
        </section>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-citations">
          <h2 id="system-citations" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Citation checks</h2>
          <p className="t-body mt-[var(--s2)]">Written by verify-research-citations.mjs when someone runs it. No workflow runs it.</p>
          <form method="get" action="/admin/system" className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
            <FilterSelect name="review_signal" label="Review signal" options={CITATION_SIGNALS} value={reviewSignal} />
            {domain && <input type="hidden" name="domain" value={domain} />}
            {localTier && <input type="hidden" name="local_tier" value={localTier} />}
            {status && <input type="hidden" name="status" value={status} />}
            <button type="submit" className="btn btn--ghost">Show citation checks</button>
          </form>
          <ReadState result={citations}>
            <table className="ledger mt-[var(--s3)]" aria-labelledby="system-citations">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Identifier</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Title found</th>
                  <th scope="col">Match method</th>
                  <th scope="col">Match score</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Review signal</th>
                  <th scope="col">Reviewer verification</th>
                </tr>
              </thead>
              <tbody>
                {citations.ok && citations.rows.map((row) => (
                  <tr key={row.source_id}>
                    <td>{row.claimed_title}</td>
                    <td>{words(row.identifier_kind)}: {row.identifier_value || 'None recorded'}</td>
                    <td>{words(row.outcome)}</td>
                    <td>{row.retrieved_title ?? 'None recorded'}</td>
                    <td>{words(row.match_method)}</td>
                    <td>{row.match_score === null ? 'None recorded' : String(row.match_score)}</td>
                    <td>{gymDay(row.checked_at)}</td>
                    <td>{words(row.review_signal)}</td>
                    <td>{words(row.verification_state)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ReadState>
        </section>

        <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby="system-retractions">
          <h2 id="system-retractions" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Retraction checks</h2>
          <p className="t-body mt-[var(--s2)]">Written by check-source-retractions.mjs when someone runs it. No workflow runs it.</p>
          <ReadState result={retractions}>
            <table className="ledger mt-[var(--s3)]" aria-labelledby="system-retractions">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Result</th>
                  <th scope="col">Notice</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Library passages from this source</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Action signal</th>
                </tr>
              </thead>
              <tbody>
                {retractions.ok && retractions.rows.map((row) => (
                  <tr key={row.source_id}>
                    <td>{row.title}</td>
                    <td>{words(row.status)}</td>
                    <td>{row.notice_type ? `${words(row.notice_type)}, ${calendarDay(row.notice_date)}` : 'None recorded'}</td>
                    <td>{words(row.disposition)}</td>
                    <td>{row.dependent_chunks}</td>
                    <td>{gymDay(row.checked_at)}</td>
                    <td>{words(row.action_signal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ReadState>
        </section>
      </div>
    </main>
  );
}
