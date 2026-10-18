'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * THE SAFETY STRIP ON THE GYM OFFICE (lane U2, audit UX-A A-2).
 *
 * An admin's morning safety check used to need four doors known by heart:
 * none of Escalations, Safety Flags, Safety Review or Compliance Center was
 * linked from the admin's home. This strip reads the one rollup
 * (/api/pilot/admin/safety-review, safetyReview.ts) and shows what is open in
 * each of its five feeds, with one link to Safety Review, where every item
 * links on to the page that acts on it.
 *
 * It only counts and links; it adds no rule, no gate and no warning. A failed
 * or partial read says it could not be read, never zero: a false all-clear is
 * the expensive mistake here. Copy is PROPOSED.
 */

interface Counts {
  holds: number;
  gates: number;
  escalations: number;
  violations: number;
  violationsTruncated: boolean;
  flags: number;
}

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'read'; counts: Counts };

const LISTS = ['openHolds', 'failingGates', 'openEscalations', 'openViolations', 'openFlags'] as const;

export default function GymOfficeSafetyStrip() {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/safety-review`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (controller.signal.aborted) return;
        if (!response.ok || LISTS.some((list) => !Array.isArray(payload[list]))) {
          setRead({ state: 'failed' });
          return;
        }
        const length = (list: (typeof LISTS)[number]) => (payload[list] as unknown[]).length;
        setRead({
          state: 'read',
          counts: {
            holds: length('openHolds'),
            gates: length('failingGates'),
            escalations: length('openEscalations'),
            violations: length('openViolations'),
            // Not stated is treated as cut, as Safety Review itself does.
            violationsTruncated: payload.violationsTruncated !== false,
            flags: length('openFlags'),
          },
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <section
      aria-labelledby="gym-office-safety"
      className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h2 id="gym-office-safety" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Safety</h2>
        <Link href="/admin/safety-review" className="btn btn--ghost">
          Open Safety Review
        </Link>
      </div>
      {read.state === 'loading' ? (
        <p className="t-body mt-[var(--s3)]">Reading the safety review…</p>
      ) : read.state === 'failed' ? (
        <p className="t-body mt-[var(--s3)]">The safety review could not be read. Open Safety Review to try again.</p>
      ) : (
        <dl className="mt-[var(--s3)] grid gap-[var(--s3)] sm:grid-cols-2 lg:grid-cols-5">
          {([
            ['Training holds', String(read.counts.holds)],
            ['Failing gate checks', String(read.counts.gates)],
            ['Open escalations', String(read.counts.escalations)],
            [
              'Compliance violations',
              read.counts.violationsTruncated ? `${read.counts.violations} in the latest read` : String(read.counts.violations),
            ],
            ['Safety flags', String(read.counts.flags)],
          ] as const).map(([label, value]) => (
            <div key={label} className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)]">
              <dt className="t-label">{label}</dt>
              <dd className="t-data mt-[var(--s1)] text-[color:var(--bone-100)]">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
