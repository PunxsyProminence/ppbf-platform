'use client';

import { useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/**
 * Loading a gym's roster from a spreadsheet.
 *
 * The screen is built around one rule: you see exactly what will happen before
 * anything happens. Checking a file produces a plan; nothing is written until
 * that plan has been read and the second button pressed. Loading forty real
 * children is not an action anyone should discover the shape of afterwards.
 *
 * The preview and the commit are produced by the SAME server-side planning
 * function, so what is approved is what runs -- not a second implementation
 * that can drift from it.
 */

type Outcome = 'create' | 'skip_exists' | 'reject';

interface RowPlan {
  line: number;
  athlete_id: string;
  full_name: string;
  outcome: Outcome;
  reason: string;
}

interface ImportResult {
  committed: boolean;
  rows: RowPlan[];
  counts: { create: number; skip_exists: number; reject: number };
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  create: 'Will be added',
  skip_exists: 'Already on the roster',
  reject: 'Cannot be added',
};

const COMMITTED_LABEL: Record<Outcome, string> = {
  create: 'Added',
  skip_exists: 'Already on the roster',
  reject: 'Not added',
};

function RosterImportConsole() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  async function send(commit: boolean) {
    setIsBusy(true);
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/roster-import`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, commit }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        committed?: boolean;
        rows?: RowPlan[];
        counts?: ImportResult['counts'];
      };
      if (!response.ok) {
        throw new Error(payload.error || 'That file could not be read.');
      }
      setResult({
        committed: payload.committed === true,
        rows: payload.rows ?? [],
        counts: payload.counts ?? { create: 0, skip_exists: 0, reject: 0 },
      });
    } catch (error) {
      // The plan is cleared on failure. Leaving a previous preview on screen
      // beside a new error would invite someone to press Add against a plan
      // that no longer describes the file in the box.
      setResult(null);
      setErrorMessage(error instanceof Error ? error.message : 'That file could not be read.');
    } finally {
      setIsBusy(false);
    }
  }

  async function readFile(file: File) {
    setErrorMessage('');
    setResult(null);
    setCsv(await file.text());
  }

  const previewed = result !== null && !result.committed;

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="mx-auto max-w-4xl">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">
          Roster
        </p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Load a roster</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          Paste a spreadsheet or choose a file. Nothing is written until you have seen what it would
          do and pressed Add. An athlete already on the roster is never overwritten, and nobody gets
          a sign-in from this screen &mdash; PINs are issued afterwards.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            Back to admin
          </Link>
          <Link
            href="/admin/export"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            Export the roster first
          </Link>
        </div>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Choose a CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose a CSV file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
              className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-2 text-sm normal-case tracking-normal"
            />
          </label>

          <label className="mt-4 block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Or paste it here
            <textarea
              aria-label="Roster CSV"
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setResult(null);
              }}
              placeholder={'Athlete ID,Full name,Date of birth,Weight class,Gym status\nath-001,A Name,2012-03-14,lightweight,training'}
              className="mt-1 h-40 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 font-mono text-xs normal-case tracking-normal"
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={csv.trim() === '' || isBusy}
              onClick={() => { void send(false); }}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 text-xs font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Checking...' : 'Check this file'}
            </button>
            <button
              type="button"
              // Only after a preview, and only when it has something to add.
              // Without the preview requirement this screen would be a button
              // that writes a file nobody has read.
              disabled={!previewed || result.counts.create === 0 || isBusy}
              onClick={() => { void send(true); }}
              className="min-h-[44px] border-2 border-[var(--black)] bg-[color:var(--brass-800)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewed ? `Add ${result.counts.create} athlete${result.counts.create === 1 ? '' : 's'}` : 'Add athletes'}
            </button>
          </div>

          {errorMessage ? (
            <p className="mt-3 border-l-4 border-[color:var(--rust-500)] bg-[var(--canvas-tan)] px-3 py-2 text-sm leading-6">
              {errorMessage}
            </p>
          ) : null}
        </section>

        {result ? (
          <section className="mt-6">
            <h2 className="font-display text-xl font-black tracking-tight">
              {result.committed ? 'What was loaded' : 'What this would do'}
            </h2>

            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2">
                {result.committed ? 'Added' : 'To add'}: <strong>{result.counts.create}</strong>
              </span>
              <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2">
                Already on the roster: <strong>{result.counts.skip_exists}</strong>
              </span>
              <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2">
                {result.committed ? 'Not added' : 'Cannot be added'}: <strong>{result.counts.reject}</strong>
              </span>
            </div>

            {result.committed && result.counts.reject > 0 ? (
              <p className="mt-3 border-l-4 border-[color:var(--rust-500)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm leading-6">
                The rest of the file was loaded. Fix the rows below and load the file again &mdash;
                the athletes already added will be reported as already on the roster rather than
                duplicated.
              </p>
            ) : null}

            <ul className="mt-4 grid gap-2">
              {result.rows.map((row) => (
                <li
                  key={`${row.line}-${row.athlete_id}`}
                  className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                    <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                      Row {row.line}
                    </span>
                    <span
                      className={
                        row.outcome === 'reject'
                          ? 'border-2 border-[color:var(--rust-500)] bg-[var(--canvas-tan)] px-2 py-1 text-[color:var(--rust-500)]'
                          : 'border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]'
                      }
                    >
                      {(result.committed ? COMMITTED_LABEL : OUTCOME_LABEL)[row.outcome]}
                    </span>
                  </div>
                  <p className="mt-2 leading-6">
                    <strong>{row.full_name || '(no name)'}</strong>
                    {row.athlete_id ? ` · ${row.athlete_id}` : ''}
                  </p>
                  {row.reason ? (
                    <p className="mt-1 leading-6 text-[var(--gray-dark)]">{row.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default function RosterImportPage() {
  // Matches the route exactly: organization_admin only. A coach cannot load a
  // roster, and neither can the platform owner -- creating this gym's children
  // is the gym's own administrator's act.
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <RosterImportConsole />
    </RoleSessionGate>
  );
}
