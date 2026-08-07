'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// The seat-specific half of a board workspace: the records this platform
// actually holds for the seat accountable for them.
//
// Only two seats have any. The Secretary's is the announcement register, which
// is the only governance record the platform keeps; the Program & Safety
// Director's is the written compliance standard. Every other seat's duty --
// finances, minutes, filings, the risk register -- is not stored here at all,
// and the workspace already says so plainly rather than rendering an empty
// panel per duty. This component adds nothing for those seats on purpose.

interface ComplianceRule {
  rule_id: string;
  rule_name: string;
  rule_category: string;
  severity: string;
  escalation_level: string;
}

interface Announcement {
  announcement_id: string;
  message: string;
  author_name: string;
  author_role: string;
  created_at: string;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function formatWhen(value: string): string {
  const parsed = new Date(value);
  return formatGymDateNumeric(parsed) ?? 'Date unavailable';
}

export default function BoardSeatEvidence({ seat }: Readonly<{ seat: BoardSeatSlug }>) {
  const [rules, setRules] = useState<ComplianceRule[] | null>(null);
  const [notices, setNotices] = useState<Announcement[] | null>(null);
  const [failed, setFailed] = useState(false);

  const wantsRules = seat === 'safety-director';
  const wantsNotices = seat === 'secretary';

  useEffect(() => {
    if (!wantsRules && !wantsNotices) return undefined;
    const controller = new AbortController();

    void (async () => {
      try {
        if (wantsRules) {
          const response = await fetch(`${apiBase()}/api/pilot/board/compliance-rules`, {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('unavailable');
          const payload = (await response.json()) as { rules?: ComplianceRule[] };
          if (!controller.signal.aborted) setRules(payload.rules ?? []);
          return;
        }

        const response = await fetch(`${apiBase()}/api/pilot/announcements/get`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          // The register claims full publication history, so it reads the
          // authoring view rather than only currently-live gym notices.
          body: JSON.stringify({ view: 'authoring', limit: 25 }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const payload = (await response.json()) as { announcements?: Announcement[]; items?: Announcement[] };
        if (!controller.signal.aborted) setNotices(payload.announcements ?? payload.items ?? []);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();

    return () => controller.abort();
  }, [wantsRules, wantsNotices]);

  if (!wantsRules && !wantsNotices) {
    return null;
  }

  // A failed read is said out loud rather than rendered as an empty register.
  // On a safeguarding surface the two look identical and mean opposite things.
  if (failed) {
    return (
      <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
        <h2 className="t-command text-[length:var(--t-md)]">Records could not be read</h2>
        <p className="t-body mt-[var(--s2)]">
          This is a failure to load, not an empty register. Reload to try again.
        </p>
      </article>
    );
  }

  if (wantsRules) {
    if (!rules) return null;

    const ordered = [...rules].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
    );

    return (
      <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
        <h2 className="t-command text-[length:var(--t-md)]">The standard this gym holds itself to</h2>
        <p className="t-body mt-[var(--s2)]">
          These rules are written policy. Nothing evaluates them automatically — a violation exists only
          when a coach or admin files one, so this is what the gym has committed to, not evidence it is
          being met.
        </p>

        {ordered.length === 0 ? (
          <p className="t-body mt-[var(--s4)]">
            This gym has no active compliance rules on record.
          </p>
        ) : (
          <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
            {ordered.map((rule) => (
              <li key={rule.rule_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
                <div className="flex flex-wrap items-baseline justify-between gap-[var(--s2)]">
                  <p className="t-data">{rule.rule_name}</p>
                  <p className="font-mono text-[length:var(--t-xs)] uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                    {rule.severity}
                  </p>
                </div>
                <p className="t-muted mt-[var(--s1)]">
                  {rule.rule_category} &middot; escalates to {rule.escalation_level}
                </p>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  }

  if (!notices) return null;

  return (
    <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
      <h2 className="t-command text-[length:var(--t-md)]">Board communications register</h2>
      <p className="t-body mt-[var(--s2)]">
        Every notice published to this organization, with its author. This is the platform&apos;s only
        standing governance record — it is notices, not minutes, and no resolution or vote is recorded
        anywhere here.
      </p>

      {notices.length === 0 ? (
        <p className="t-body mt-[var(--s4)]">No notices have been published.</p>
      ) : (
        <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
          {notices.map((notice) => (
            <li key={notice.announcement_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
              <p className="t-body">{notice.message}</p>
              <p className="t-data mt-[var(--s2)] uppercase tracking-[0.12em]">
                {notice.author_name} &middot; {notice.author_role} &middot; {formatWhen(notice.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
