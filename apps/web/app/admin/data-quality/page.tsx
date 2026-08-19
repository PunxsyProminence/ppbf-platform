'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Data quality (register module 134's admin surface). One check today:
// guardians split across two records -- the #281 import-then-invite split,
// where a signed-in guardian silently cannot see some of their own children.
//
// The posture this page inherits from the CI check it surfaces: emails are
// masked, athletes are ids only, and there is NO merge button. Merging two
// guardian records means deciding which family is which -- a human's call.
// This page reports the blast radius and the remediation keys.

interface DuplicateGroup {
  email: string;
  record_count: number;
  claimed_count: number;
  unclaimed_count: number;
  account_ids: string[];
  parent_ids: string[];
  hidden_athlete_ids: string[];
}

export default function DataQualityPage() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/data-quality/duplicate-guardians`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to run the duplicate-guardian check.');
        const payload = (await response.json()) as { items?: DuplicateGroup[] };
        if (controller.signal.aborted) return;
        setGroups(payload.items ?? []);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to run the duplicate-guardian check.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const findings = groups.filter((group) => group.hidden_athlete_ids.length > 0);
  const informational = groups.filter((group) => group.hidden_athlete_ids.length === 0);

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Data Quality</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Duplicate Guardians</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Guardians split across two records — where the signed-in account may not see all of
              their own children. Merging records is a human decision about which family is which,
              so this page reports and never merges. Emails are masked; athletes are ids.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Check failed</p>
                <p className="alert-msg">{errorMessage} Duplicates may exist that are not shown here.</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Running the check...</span>
            </div>
          ) : !errorMessage && groups.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No split guardian records</div>
                <p className="empty-msg mx-auto">Every guardian email maps to exactly one record.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s4)]">
              {findings.length > 0 && (
                <section>
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Children hidden from their guardian</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                    {findings.map((group) => (
                      <li key={group.parent_ids.join(':')} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                        <div className="flex flex-wrap items-center gap-[var(--s3)]">
                          <span className="t-body font-semibold text-[color:var(--bone-100)]">{group.email}</span>
                          <span className="badge badge--locked"><i aria-hidden="true">✕</i>{group.hidden_athlete_ids.length} hidden</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                            {group.record_count} records ({group.claimed_count} claimed, {group.unclaimed_count} unclaimed)
                          </span>
                        </div>
                        <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                          Hidden athlete ids: {group.hidden_athlete_ids.join(', ')}
                        </p>
                        <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                          Remediation keys — parent records: {group.parent_ids.join(', ')}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {informational.length > 0 && (
                <section>
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Split but currently harmless</h2>
                  <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                    The split is real but every child is still reachable through a claimed record.
                  </p>
                  <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                    {informational.map((group) => (
                      <li key={group.parent_ids.join(':')} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                        <div className="flex flex-wrap items-center gap-[var(--s3)]">
                          <span className="t-body font-semibold text-[color:var(--bone-100)]">{group.email}</span>
                          <span className="badge badge--monitor"><i aria-hidden="true">◉</i>informational</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                            {group.record_count} records — parent ids: {group.parent_ids.join(', ')}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
