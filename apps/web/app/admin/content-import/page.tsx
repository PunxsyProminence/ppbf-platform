"use client";

import { useState } from 'react';
import Link from 'next/link';

import RefusalStamp from '@/components/RefusalStamp';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type { PlanUnitView, PlanView } from '@/src/server/pilot/contentImport/upload';

/**
 * The screen over POST /api/pilot/admin/content-import (IMP-12; R1 "for
 * future work it will be 2"): the gym's reference content from CSV files,
 * through the same core the seed workflow runs.
 *
 * One rule shapes it, the roster screen's rule (app/admin/import/page.tsx):
 * you see exactly what will happen before anything happens. Choosing files
 * and pressing Check produces a plan -- new, new version, unchanged, absent,
 * blocking findings, warnings -- and nothing is written. Apply sends the plan's
 * hash back, so what is applied is what was shown; if the gym's content moved
 * in between, the server refuses and the screen says to check again.
 *
 * APPLY IS OFF WHILE ANYTHING BLOCKS. A blocking finding is something the
 * database would refuse or that would load wrong (validate.ts), so there is
 * nothing to apply until the files are fixed and checked again. Warnings
 * never block.
 *
 * The gate is 'admin' only, the client spelling of organization_admin and
 * admin, which is exactly the route's requireRole list; a coach and the
 * platform owner are refused there. The organization is never sent from here:
 * the route takes it from the session.
 *
 * Files are read in the browser as text. Only .csv files are read; anything
 * else is sent by name alone, so the core can refuse a video or a photo
 * (validate.ts 'media_file') without its bytes ever leaving the device.
 */

interface ChosenFile {
  readonly name: string;
  readonly text: string;
  readonly bytes: number;
}

interface WrittenDataset {
  inserted?: string[];
  updated?: string[];
  ledgerRows?: number;
}

type Result =
  | { readonly kind: 'refused'; readonly during: 'check' | 'apply'; readonly httpStatus: number; readonly message: string }
  | { readonly kind: 'unknown'; readonly during: 'check' | 'apply' }
  | {
    readonly kind: 'applied';
    readonly importId: string | null;
    readonly auditId: string | null;
    readonly written: Record<string, WrittenDataset>;
    readonly auditMirror: string;
  };

type PromptState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly text: string; readonly copied: boolean }
  | { readonly kind: 'refused'; readonly httpStatus: number; readonly message: string }
  | { readonly kind: 'unreachable' };

const DATASET_LABEL: Record<string, string> = {
  disciplines: 'Disciplines',
  'competence-levels': 'Competence levels',
  'cohort-definitions': 'Cohorts',
  'drill-library': 'Drill library',
  'universal-stop-rules': 'Universal stop rules',
  'workout-templates': 'Workout templates',
  'session-scripts': 'Session scripts',
  'transfer-claims': 'Transfer claims',
  'assessment-protocols': 'Assessment protocols',
};

/* Law 3 (docs/FRONTEND_STYLE_CONTRACT.md:43-45): every state is a .badge
   carrying one of the contract's four glyphs and an uppercase label, never
   colour alone. ✓ goes in or is already in, ◉ is worth a look (the warnings'
   mark below), ✕ cannot be loaded. None of these is a safety state or a
   queue outcome, so each takes the administrative rung, .badge--filed
   (design-system/legacy/ppbf-leather-brass.css:818-821), and nothing is
   painted (Law 2). */
const OUTCOME_MARK: Record<PlanUnitView['outcome'], { glyph: '✓' | '◉' | '✕'; label: string }> = {
  new: { glyph: '✓', label: 'NEW' },
  new_version: { glyph: '✓', label: 'NEW VERSION' },
  unchanged: { glyph: '✓', label: 'UNCHANGED' },
  absent: { glyph: '◉', label: 'ABSENT' },
  reject: { glyph: '✕', label: 'REJECT' },
};

function OutcomeBadge({ outcome }: { readonly outcome: PlanUnitView['outcome'] }) {
  const mark = OUTCOME_MARK[outcome];
  return (
    <span className="badge badge--filed">
      <i aria-hidden="true">{mark.glyph}</i>
      {mark.label}
    </span>
  );
}

function datasetLabel(name: string): string {
  return DATASET_LABEL[name] ?? name;
}

/** RefusalStamp appends `detail` and its own full stop (data-deletion/page.tsx, same helper). */
function trimTrailingPeriod(message: string): string {
  return message.endsWith('.') ? message.slice(0, -1) : message;
}

/* FileReader rather than File.text(): the same answer in every browser the
   gym has, and in the test DOM, which has no File.text(). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

function isCsv(name: string): boolean {
  return name.toLowerCase().endsWith('.csv');
}

function kilobytes(bytes: number): string {
  // Intl, not toLocaleString: gymTimeDrift.test.ts bans toLocale*String outside gymTime.ts.
  return `${new Intl.NumberFormat('en-US').format(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

function where(finding: PlanView['blocking'][number]): string {
  const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return `${at}${finding.column ? ` ${finding.column}` : ''}${finding.key ? ` (${finding.key})` : ''}`;
}

function unitName(unit: PlanUnitView): string {
  const id = unit.package_key ? `${unit.key} (${unit.package_key})` : unit.key;
  return unit.label ? `${unit.label} · ${id}` : id;
}

async function errorText(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === 'string' && payload.error.trim() ? payload.error : `HTTP ${response.status}`;
}

function UnitList({ units, title, note }: { readonly units: PlanUnitView[]; readonly title: string; readonly note?: string }) {
  if (units.length === 0) return null;
  return (
    <section className="space-y-[var(--s2)]">
      <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{title} ({units.length})</h3>
      {note ? <p className="t-muted">{note}</p> : null}
      <ul className="t-body space-y-[var(--s2)]">
        {units.map((unit) => (
          <li key={`${unit.dataset}-${unit.key}`} className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
            <OutcomeBadge outcome={unit.outcome} />{' '}
            {datasetLabel(unit.dataset)}: {unitName(unit)}
            {unit.outcome === 'new_version' && unit.from_version !== undefined && unit.to_version !== undefined
              ? <span className="t-data"> (history v{unit.from_version} → v{unit.to_version})</span>
              : null}
            {unit.reasons?.length ? <span className="block t-muted">{unit.reasons.join(' · ')}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContentImportScreen() {
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [applied, setApplied] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ kind: 'idle' });

  async function choose(chosen: File[]) {
    // A new choice is a new package: the old plan describes files that are
    // no longer the ones on screen, so it goes, and Apply with it.
    setPlan(null);
    setApplied(false);
    setResult(null);
    setReading(true);
    try {
      const read = await Promise.all(chosen.map(async (file) => ({
        name: file.name,
        text: isCsv(file.name) ? await readText(file) : '',
        bytes: file.size,
      })));
      setFiles(read);
    } catch {
      setFiles([]);
      setResult({ kind: 'refused', during: 'check', httpStatus: 400, message: 'one of the files could not be read on this device' });
    } finally {
      setReading(false);
    }
  }

  async function send(commit: boolean) {
    const during = commit ? 'apply' : 'check';
    setBusy(during);
    setResult(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/content-import`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: files.map((file) => ({ name: file.name, text: file.text })),
          ...(commit && plan ? { commit: true, plan_hash: plan.plan_hash } : {}),
        }),
      });
      if (!response.ok) {
        // Any refusal clears the plan: a plan left on screen beside a refusal
        // invites pressing Apply against something that is no longer true.
        setPlan(null);
        setApplied(false);
        setResult({ kind: 'refused', during, httpStatus: response.status, message: await errorText(response) });
        return;
      }
      const payload = (await response.json()) as {
        committed?: boolean;
        plan?: PlanView;
        import_id?: string | null;
        audit_id?: string | null;
        written?: Record<string, WrittenDataset>;
        audit_mirror?: string;
      };
      setPlan(payload.plan ?? null);
      // The plan on screen is what THIS answer describes: loaded after an
      // Apply, only proposed after a Check -- including a Check pressed after
      // an Apply to see whether it went through, whose plan was not applied
      // and must be appliable if it still has changes.
      setApplied(commit);
      if (commit) {
        setResult({
          kind: 'applied',
          importId: payload.import_id ?? null,
          auditId: payload.audit_id ?? null,
          written: payload.written ?? {},
          auditMirror: payload.audit_mirror ?? 'not reported',
        });
      }
    } catch {
      // The request may or may not have reached the server. Say so; never
      // claim that nothing happened.
      setPlan(null);
      setApplied(false);
      setResult({ kind: 'unknown', during });
    } finally {
      setBusy(null);
    }
  }

  /* The workout prompt is fetched when asked for, shown in full, and copied.
     It is SHOWN as well as copied because a gym tablet may refuse the
     clipboard (navigator.clipboard is undefined outside a secure context, and
     writeText can reject); the text on screen can always be selected by hand,
     and the screen says which of the two happened rather than "Copied" either
     way (the rule activation-codes/page.tsx follows). */
  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function workoutPrompt() {
    // Already fetched: copy straight away, inside the press. A tablet browser
    // may refuse a clipboard write that comes after a network round trip, so
    // the second press is the one that can succeed there -- and a failed
    // refetch can never take away text that is already on screen.
    if (prompt.kind === 'ready') {
      const text = prompt.text;
      setPrompt({ kind: 'ready', text, copied: await copyText(text) });
      return;
    }
    setPrompt({ kind: 'loading' });
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/content-import`, { method: 'GET', credentials: 'include' });
      if (!response.ok) {
        setPrompt({ kind: 'refused', httpStatus: response.status, message: await errorText(response) });
        return;
      }
      const payload = (await response.json()) as { prompt?: unknown };
      if (typeof payload.prompt !== 'string' || payload.prompt.trim() === '') {
        setPrompt({ kind: 'unreachable' });
        return;
      }
      setPrompt({ kind: 'ready', text: payload.prompt, copied: await copyText(payload.prompt) });
    } catch {
      setPrompt({ kind: 'unreachable' });
    }
  }

  const blocking = plan?.blocking ?? [];
  const canApply = plan !== null && !applied && blocking.length === 0 && plan.changes > 0 && busy === null;
  const byOutcome = (outcome: PlanUnitView['outcome']) => (plan?.units ?? []).filter((unit) => unit.outcome === outcome);

  return (
    /* data-surface="kiosk" -- Law 5, as on data-deletion/page.tsx: the 55px
       tap floor and 19.1px type floor, because this may be run from a gym
       tablet. No room class: rooms are retired as a visual concept. */
    <main data-surface="kiosk" className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Admin Workspace</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Load Gym Content</h1>
          <p className="t-body max-w-3xl">
            Choose the content files &mdash; disciplines, competence levels, cohorts, drills, stop rules,
            workout templates, session scripts &mdash; and check them. Nothing is written until you have
            seen what they would do and pressed Apply. A changed item gets a new version and the old one
            is kept; an item missing from your files is left alone; nothing is deleted.
          </p>
          <p className="t-muted max-w-3xl">
            Research, video and photos are not loaded here.
          </p>
        </header>

        <section className="mt-[var(--s6)] space-y-[var(--s3)]" aria-labelledby="workout-prompt-heading">
          <h2 id="workout-prompt-heading" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
            A workout written in your own words
          </h2>
          <ol className="t-body max-w-3xl list-decimal space-y-[var(--s1)] pl-[var(--s5)]">
            <li>Copy the workout prompt and paste it into any AI assistant.</li>
            <li>Paste your workout under it. It answers with two files, or asks you for what is missing.</li>
            <li>Save the two files with the names it gives, then choose them below and check them.</li>
          </ol>
          <p className="t-muted max-w-3xl">
            The prompt lists your gym&apos;s current drills by name, id, skill code and most contact, so a step that clearly is one of
            them can be linked to it. That list goes to the AI you paste it into. Nothing about athletes is in it.
          </p>
          <p className="t-muted max-w-3xl">
            A workout that is already loaded is changed by its id, not by its name. Check the changed files: the
            finding names the id (it starts wtp_). Tell the assistant that id and ask for the files again; the
            change then loads as a new version and the old one is kept.
          </p>
          <button
            type="button"
            disabled={prompt.kind === 'loading'}
            onClick={() => {
              void workoutPrompt();
            }}
            className="btn btn--ghost btn--tap disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt.kind === 'loading' ? 'Getting the prompt...' : 'Copy the workout prompt'}
          </button>

          {prompt.kind === 'ready' ? (
            <div className="field">
              <p className="t-body" role="status">
                {prompt.copied
                  ? 'Copied. Paste it into the AI assistant, then paste your workout under it.'
                  : 'This device would not copy it. Press the button again, or tap the text below to select all of it and copy it yourself.'}
              </p>
              <label className="t-label" htmlFor="workout-prompt">Workout prompt</label>
              <textarea
                id="workout-prompt"
                readOnly
                rows={10}
                className="textarea w-full"
                value={prompt.text}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          ) : null}

          {prompt.kind === 'refused' ? (
            prompt.httpStatus === 401 ? (
              <RefusalStamp kind="signed_out" detail="sign in again with Microsoft, then reload this page" />
            ) : prompt.httpStatus < 500 ? (
              <RefusalStamp kind="cannot_be_done" detail={trimTrailingPeriod(prompt.message)} />
            ) : (
              <p className="t-body" role="status">
                The server answered with an error (HTTP {prompt.httpStatus}). The prompt was not fetched.
              </p>
            )
          ) : null}

          {prompt.kind === 'unreachable' ? (
            <p className="t-body" role="status">The server could not be reached. The prompt was not fetched.</p>
          ) : null}
        </section>

        <section className="frame mt-[var(--s6)]">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather space-y-[var(--s4)] p-[var(--s5)]">
            <div className="field">
              <label className="t-label" htmlFor="content-files">Content files (CSV)</label>
              <input
                id="content-files"
                type="file"
                multiple
                accept=".csv,text/csv"
                className="input w-full"
                disabled={busy !== null || reading}
                onChange={(event) => {
                  // Take the files, THEN empty the input: a browser fires no
                  // change for the same path chosen again, so a CSV edited
                  // after a blocking finding and re-chosen would otherwise be
                  // ignored and the text read the first time sent again (the
                  // same reset as coach/video-analysis/capture/page.tsx:268-269).
                  const chosen = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void choose(chosen);
                }}
              />
            </div>

            {files.length > 0 ? (
              <ul className="t-body space-y-[var(--s1)]" aria-label="Chosen files">
                {files.map((file) => (
                  <li key={file.name} className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
                    <span className="t-data">{file.name}</span> <span className="t-muted">{kilobytes(file.bytes)}</span>
                    {isCsv(file.name) ? null : <span className="t-muted"> &mdash; not a CSV; sent by name only</span>}
                  </li>
                ))}
              </ul>
            ) : null}

            <button
              type="button"
              disabled={files.length === 0 || busy !== null || reading}
              onClick={() => {
                void send(false);
              }}
              className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'check' ? 'Checking...' : 'Check these files'}
            </button>

            {result?.kind === 'refused' && result.httpStatus < 500 ? (
              <div>
                {result.httpStatus === 401 ? (
                  <RefusalStamp kind="signed_out" detail="sign in again with Microsoft, then reload this page" />
                ) : (
                  <RefusalStamp kind="cannot_be_done" detail={trimTrailingPeriod(result.message)} />
                )}
                <p className="t-body mt-[var(--s3)]">
                  Nothing was written.{result.httpStatus === 409 ? ' Check the files again to see the plan as it stands now.' : ''}
                </p>
              </div>
            ) : null}

            {result?.kind === 'refused' && result.httpStatus >= 500 ? (
              <p className="t-body" role="status">
                {result.during === 'apply'
                  ? `The server answered with an error (HTTP ${result.httpStatus}: ${result.message}) and could not confirm whether the content was applied. Check the files again: anything that went through shows as unchanged.`
                  : `The server answered with an error (HTTP ${result.httpStatus}: ${result.message}). Nothing was checked.`}
              </p>
            ) : null}

            {result?.kind === 'unknown' ? (
              <p className="t-body" role="status">
                {result.during === 'apply'
                  ? 'The screen could not tell whether the content was applied. Check the files again: anything that went through shows as unchanged.'
                  : 'The server could not be reached. Nothing was checked.'}
              </p>
            ) : null}
          </div>
        </section>

        {plan ? (
          <section className="mt-[var(--s6)] space-y-[var(--s5)]" aria-label="Plan">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
              {applied ? 'What was loaded' : 'What this would do'}
            </h2>
            {/* The gym is the session's (route.ts); shown so a person signed in
                to the wrong gym sees it before pressing Apply. */}
            <p className="t-body">
              Gym <span className="t-data">{plan.organization_id}</span>, as{' '}
              <span className="t-data">{plan.actor.account_id}</span> ({plan.actor.role})
            </p>

            <ul className="t-body space-y-[var(--s2)]">
              {plan.datasets.map((name) => {
                const counts = plan.counts[name];
                if (!counts) return null;
                return (
                  <li key={name} className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                    <strong>{datasetLabel(name)}</strong>{' '}
                    <span className="t-data">
                      {counts.new} new · {counts.new_version} new version · {counts.unchanged} unchanged · {counts.absent} absent · {counts.reject} reject
                    </span>
                  </li>
                );
              })}
            </ul>

            {blocking.length > 0 ? (
              <section className="space-y-[var(--s2)]" aria-label="Blocking findings">
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>▲ BLOCKING ({blocking.length})</h3>
                <p className="t-body">
                  Apply stays off until every one of these is fixed in the files and they are checked again.
                </p>
                <ul className="t-body space-y-[var(--s2)]">
                  {blocking.map((finding, index) => (
                    <li key={`${finding.code}-${finding.file}-${finding.line ?? 0}-${index}`} className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                      <span className="t-data">▲ {finding.code} · {where(finding)}</span>
                      <span className="block">{finding.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {plan.warnings.length > 0 ? (
              <section className="space-y-[var(--s2)]" aria-label="Warnings">
                <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>◉ WARNINGS ({plan.warnings.length})</h3>
                <p className="t-muted">Worth a second look. They never stop an apply.</p>
                <ul className="t-body space-y-[var(--s2)]">
                  {plan.warnings.map((warning, index) => (
                    <li key={`${warning.code}-${warning.file ?? ''}-${index}`} className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
                      <span className="t-data">◉ {warning.code}{warning.file ? ` · ${warning.file}` : ''}{warning.column ? ` ${warning.column}` : ''}</span>
                      <span className="block">{warning.message}</span>
                      {warning.samples?.length ? <span className="block t-muted">e.g. {warning.samples.join('; ')}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <UnitList units={byOutcome('reject')} title="Cannot be loaded" />
            <UnitList units={byOutcome('new')} title="New" />
            <UnitList units={byOutcome('new_version')} title="New version (the old one is kept)" />
            <UnitList
              units={byOutcome('absent')}
              title="Absent"
              note="In the gym's content but not in these files. Left alone; nothing is removed."
            />
            {byOutcome('unchanged').length > 0 ? (
              <details className="t-body">
                <summary className="t-label">✓ UNCHANGED ({byOutcome('unchanged').length}): nothing is written for these</summary>
                <UnitList units={byOutcome('unchanged')} title="Unchanged" />
              </details>
            ) : null}

            {!applied ? (
              <div className="space-y-[var(--s2)]">
                <button
                  type="button"
                  disabled={!canApply}
                  onClick={() => {
                    void send(true);
                  }}
                  className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === 'apply' ? 'Applying...' : `Apply ${plan.changes} change${plan.changes === 1 ? '' : 's'}`}
                </button>
                {blocking.length > 0 ? (
                  <p className="t-muted">Apply is off: {blocking.length} blocking finding{blocking.length === 1 ? '' : 's'} above.</p>
                ) : plan.changes === 0 ? (
                  <p className="t-muted">Nothing to apply: every item is unchanged or absent.</p>
                ) : null}
              </div>
            ) : null}

            {result?.kind === 'applied' ? (
              <div className="mat-leather--raised space-y-[var(--s2)] rounded-[var(--r-md)] p-[var(--s4)]" role="status">
                <p className="t-body">
                  {result.importId
                    ? `✓ Applied: ${plan.changes} item${plan.changes === 1 ? '' : 's'} written.`
                    : '✓ Nothing to write: every item was already unchanged or absent.'}
                </p>
                {Object.entries(result.written).map(([name, written]) => (
                  <p key={name} className="t-body">
                    {datasetLabel(name)}: <span className="t-data">
                      {written.inserted?.length ?? 0} added, {written.updated?.length ?? 0} revised, {written.ledgerRows ?? 0} history rows
                    </span>
                  </p>
                ))}
                {result.importId ? (
                  <p className="t-body">
                    Import <span className="t-data">{result.importId}</span>, audit record <span className="t-data">{result.auditId ?? 'not reported'}</span>
                    {result.auditMirror === 'failed' ? '. The content is saved; only the SHADOW copy of the audit record failed.' : '.'}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="mt-[var(--s6)]">
          <Link href="/operations" className="btn btn--ghost">
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}

export default function ContentImportPage() {
  // Matches the route: organization_admin and admin only; a coach and the
  // platform owner are refused there (route.ts requireRole).
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <ContentImportScreen />
    </RoleSessionGate>
  );
}
