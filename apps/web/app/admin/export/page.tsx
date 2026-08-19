"use client";

import { useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { ROSTER_EXPORT_COLUMNS } from '@/app/api/pilot/admin/export/roster/csv';

/**
 * The screen where a gym takes its own roster out of the platform.
 *
 * The gate is 'admin' only. mapPilotRoleToClubRole keeps platform_owner
 * distinct from the organization administrators, so the page a platform owner
 * cannot use is one they also cannot open -- which matches the route, where a
 * whole-roster download is refused to that role outright.
 *
 * A failed download says so. It never falls back to a page that looks like a
 * successful export of nothing, and the athlete count it reports comes from the
 * response rather than from anything this file assumes.
 */

interface ExportResult {
  filename: string;
  // null when the server did not send a count. The page says the count is
  // unknown rather than printing a zero it did not receive.
  rowCount: number | null;
}

export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /filename="([^"]+)"/.exec(header);
  return match ? match[1] : null;
}

export default function RosterExportPage() {
  const [isWorking, setIsWorking] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  async function handleDownload() {
    setIsWorking(true);
    setErrorMessage('');
    setResult(null);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/export/roster`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `The export failed (HTTP ${response.status}).`);
      }

      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('This browser cannot save a file from this page. Try a different browser.');
      }

      const filename = filenameFromContentDisposition(response.headers.get('content-disposition'))
        ?? 'ppbf-roster.csv';
      // Matched as a whole number before it is converted: Number(null) and
      // Number('') are both 0, so a coerced parse would report a gym of zero
      // athletes when the server sent no count at all.
      const countHeader = response.headers.get('x-roster-row-count') ?? '';
      const rowCount = /^\d+$/.test(countHeader) ? Number(countHeader) : null;

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      setResult({ filename, rowCount });
    } catch (error) {
      setResult(null);
      setErrorMessage(
        error instanceof Error ? error.message : 'The export failed and no file was downloaded.',
      );
    } finally {
      setIsWorking(false);
    }
  }

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Take Your Roster With You</h1>
            <p className="t-body max-w-3xl">
              Downloads every athlete in your gym as a spreadsheet file. It is your record, readable
              without this platform, and it is what you hand a family who asks for their own
              information back.
            </p>
          </header>

          <section className="frame mt-[var(--s6)]">
            <span className="rivet rivet--tl" />
            <span className="rivet rivet--tr" />
            <span className="rivet rivet--bl" />
            <span className="rivet rivet--br" />
            <div className="frame-in mat-leather p-[var(--s5)]">
            <button
              type="button"
              disabled={isWorking}
              onClick={() => {
                void handleDownload();
              }}
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isWorking ? 'Preparing the file...' : 'Download roster (CSV)'}
            </button>

            {errorMessage ? (
              <p className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--locked-ink)]">
                ✕ Nothing was downloaded. {errorMessage}
              </p>
            ) : null}

            {result ? (
              <p className="mat-leather--raised mt-[var(--s4)] rounded-[var(--r-md)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--bone-200)]">
                ✓ Saved <span className="t-data text-[color:var(--bone-100)]">{result.filename}</span>
                {result.rowCount === null
                  ? '. The file downloaded, but the server did not report how many athletes it holds.'
                  : ` with ${result.rowCount} ${result.rowCount === 1 ? 'athlete' : 'athletes'}.`}
              </p>
            ) : null}
            </div>
          </section>

          <section className="mt-[var(--s6)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>What is in the file</h2>
            <p className="t-body mt-[var(--s3)]">
              One row per athlete in your gym, and no other gym is ever included.
            </p>
            <ul className="mt-[var(--s3)] grid gap-[var(--s1)] sm:grid-cols-2">
              {ROSTER_EXPORT_COLUMNS.map((column) => (
                <li key={column.key} className="t-data border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)] leading-6">
                  {column.header}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-[var(--s6)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>What is not in the file</h2>
            <ul className="t-body mt-[var(--s3)] space-y-[var(--s2)]">
              <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                No PINs, no stored password hashes, and no sign-in tokens. The athlete sign-in ID is
                included because you need it to rebuild a roster; the credential on it is not.
              </li>
              <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                No medical intake, waivers, attendance, session records, coach reviews or pain
                reports. Those are held in the database and there is no screen that exports them
                today.
              </li>
            </ul>
          </section>

          <section className="mt-[var(--s6)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Before you open it</h2>
            <ul className="t-body mt-[var(--s3)] space-y-[var(--s2)]">
              <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
                Every download is recorded: which account asked, when, and how many athletes the file
                held. Somebody can be told later who took a copy.
              </li>
              <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
                The file is not encrypted and it names minors, their guardians and their emergency
                contacts. Keep it the way you would keep the paper roster.
              </li>
              <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
                Any value starting with <span className="t-data">=</span>,{' '}
                <span className="t-data">+</span>, <span className="t-data">-</span> or{' '}
                <span className="t-data">@</span> is written with a leading apostrophe so a
                spreadsheet cannot run it as a formula. Remove the apostrophe to get the value the
                gym recorded.
              </li>
            </ul>
          </section>

          <div className="mt-[var(--s6)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
