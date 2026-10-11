"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateShort } from '@/src/lib/gymTime';

const TRACKED_WAIVER_TYPES = ['general', 'medical_release', 'photo_media', 'travel'] as const;
type TrackedWaiverType = (typeof TRACKED_WAIVER_TYPES)[number];

const WAIVER_TYPE_LABEL: Record<TrackedWaiverType, string> = {
  general: 'General',
  medical_release: 'Medical release',
  photo_media: 'Photo & media',
  travel: 'Travel',
};

type WaiverStatus = 'signed' | 'declined' | 'withdrawn' | 'missing';

/**
 * The one cleared-tonight answer for an athlete and the records it rests on,
 * as the route sends it (src/server/pilot/clearedTonight.ts; Jason,
 * OD-2026-10-08-006 A-Q19: "Build one answer").
 *
 * The answer follows training holds and medical clearance, the two rules the
 * app already has, and "Why" lists those two. Waivers, photo and media
 * consent and open violations are listed apart, under "Also on file", and
 * never change it. Nothing on this screen stops anyone training.
 */
type TonightAnswer = 'cleared' | 'cleared_to_train' | 'cleared_no_contact' | 'not_cleared' | 'unavailable';

interface Tonight {
  answer: TonightAnswer;
  hold: { scope: string; athlete_explanation: string; lift_condition_text: string; expires_at: string | null } | null | 'unavailable';
  medical: { status: string; current: boolean; expires_at: string | null } | 'unavailable';
  waivers: Array<{ type: TrackedWaiverType; status: WaiverStatus; recorded_on: string | null }>;
  media_consent: { basis: 'guardian'; status: WaiverStatus } | { basis: 'adult_own_consent' };
  open_violations: number | 'unavailable';
}

interface AthleteWaiverRow {
  athlete_id: string;
  athlete_name: string;
  active_flag: boolean;
  waivers: Record<TrackedWaiverType, WaiverStatus>;
  tonight?: Tonight;
}

// Room DNA (clinic): --locked is what this room says when a clinician or a
// hold has stopped something, which is exactly what 'not cleared' reports.
// A read that failed is not that, and sits on --restricted as it does on
// /coach/sports-medicine. Its label says what happened to the read, because
// "unavailable" under a column headed Tonight reads as the athlete being
// away. Law 3: glyph and label, never the colour alone.
const TONIGHT_BADGE: Record<TonightAnswer, { rung: string; glyph: string; label: string }> = {
  cleared: { rung: 'badge--cleared', glyph: '✓', label: 'Cleared' },
  // No hold, and no contact clearance in force because none is on file, one is
  // pending or one has expired. Nobody decided "no contact" about this
  // athlete, so the answer does not say it: same rung and glyph as cleared,
  // with the contact clearance stated beside it as what is on file.
  cleared_to_train: { rung: 'badge--cleared', glyph: '✓', label: 'Cleared to train' },
  cleared_no_contact: { rung: 'badge--monitor', glyph: '◉', label: 'Cleared, no contact' },
  not_cleared: { rung: 'badge--locked', glyph: '✕', label: 'Not cleared' },
  unavailable: { rung: 'badge--restricted', glyph: '▲', label: 'Could not be read' },
};

const HOLD_SCOPE_WORDS: Record<string, string> = {
  all_training: 'all training paused',
  contact_only: 'no contact',
  conditioning_only: 'conditioning only, recorded; the app does not act on this scope',
};

const MEDICAL_WORDS: Record<string, string> = {
  cleared: 'cleared',
  restricted: 'restricted',
  not_cleared: 'not cleared',
  pending: 'pending',
  cleared_expired: 'expired',
  no_record: 'none on file',
};

const PAPER_NAMES: Record<TrackedWaiverType, string> = {
  general: 'General waiver',
  medical_release: 'Medical release',
  photo_media: 'Photo and media consent',
  travel: 'Travel waiver',
};

const PAPER_WORDS: Record<WaiverStatus, string> = {
  signed: 'signed',
  declined: 'declined',
  withdrawn: 'withdrawn',
  missing: 'none on file',
};

// Media consent is asked guardian by guardian (waiverCompliance.ts
// mediaConsentAsWaiverStatus): 'signed' means every linked guardian signed,
// 'withdrawn' or 'declined' means one of them did, and 'missing' covers no
// guardian linked and a guardian who has not answered. "None on file" would
// be false when one of two guardians signed, so each word says whose it is.
const MEDIA_WORDS: Record<WaiverStatus, string> = {
  signed: 'signed by every guardian',
  declined: 'declined by a guardian',
  withdrawn: 'withdrawn by a guardian',
  missing: 'not on file from every guardian',
};

/** The medical record in its own word, with the day its clearance ends or ended. */
function medicalWords(medical: { status: string; expires_at: string | null }): string {
  const ends = formatGymDateShort(medical.expires_at);
  const word = MEDICAL_WORDS[medical.status] ?? medical.status;
  if (!ends) return word;
  if (medical.status === 'cleared') return `${word} until ${ends}`;
  return medical.status === 'cleared_expired' ? `${word} ${ends}` : word;
}

/**
 * The line beside a "Cleared to train" answer: what is on file about contact,
 * as a fact and not a prohibition. Only that answer carries it.
 */
function contactClearanceLine(tonight: Tonight): string | null {
  if (tonight.answer !== 'cleared_to_train' || tonight.medical === 'unavailable') return null;
  return `Contact clearance: ${medicalWords(tonight.medical)}.`;
}

/**
 * One plain statement per record, in two groups that must not be read as one.
 * `why` is what the answer rests on: the hold and the medical clearance.
 * `alsoOnFile` is everything else, which by ruling never changes the answer.
 * Listed together under "Why", a missing paper or an open violation read as
 * part of the reason an athlete was not cleared. Statements, not warnings: a
 * paper that is not on file is said the same way as one that is.
 */
function tonightReasons(tonight: Tonight): { why: string[]; alsoOnFile: string[] } {
  const lines: string[] = [];
  const alsoOnFile: string[] = [];

  if (tonight.hold === 'unavailable') {
    lines.push('Training hold: could not be read.');
  } else if (!tonight.hold) {
    lines.push('Training hold: none active.');
  } else {
    const until = formatGymDateShort(tonight.hold.expires_at);
    const parts = [`Training hold: ${HOLD_SCOPE_WORDS[tonight.hold.scope] ?? tonight.hold.scope}${until ? `, until ${until}` : ''}.`];
    if (tonight.hold.athlete_explanation.trim()) parts.push(tonight.hold.athlete_explanation.trim());
    if (tonight.hold.lift_condition_text.trim()) parts.push(`What earns the lift: ${tonight.hold.lift_condition_text.trim()}`);
    lines.push(parts.join(' '));
  }

  if (tonight.medical === 'unavailable') {
    lines.push('Medical clearance: could not be read.');
  } else {
    lines.push(`Medical clearance: ${medicalWords(tonight.medical)}.`);
  }

  for (const waiver of tonight.waivers) {
    const day = waiver.recorded_on ? ` ${formatCalendarDay(waiver.recorded_on)}` : '';
    alsoOnFile.push(`${PAPER_NAMES[waiver.type]}: ${PAPER_WORDS[waiver.status]}${day}.`);
  }

  alsoOnFile.push(
    tonight.media_consent.basis === 'guardian'
      ? `${PAPER_NAMES.photo_media}: ${MEDIA_WORDS[tonight.media_consent.status]}.`
      : `${PAPER_NAMES.photo_media}: the athlete is 18 or over, so a guardian's consent no longer counts for a new publication and the athlete's own cannot be recorded yet.`,
  );

  alsoOnFile.push(
    tonight.open_violations === 'unavailable'
      ? 'Open compliance violations: could not be read.'
      : `Open compliance violations: ${tonight.open_violations === 0 ? 'none' : tonight.open_violations}.`,
  );

  return { why: lines, alsoOnFile };
}

type Filter = 'incomplete' | 'complete' | 'all';

/**
 * `?view=all` opens on every athlete. The compliance centre's "Cleared
 * tonight" link uses it: the worklist's own default hides an athlete whose
 * papers are all signed, and that is exactly the athlete a hold can be on.
 * Read once, the way /admin reads its tab.
 */
function initialFilter(): Filter {
  if (typeof window === 'undefined') return 'incomplete';
  return new URLSearchParams(window.location.search).get('view') === 'all' ? 'all' : 'incomplete';
}

function isComplete(row: AthleteWaiverRow): boolean {
  return TRACKED_WAIVER_TYPES.every((type) => row.waivers[type] === 'signed');
}

export default function WaiverComplianceAuditPage() {
  const [items, setItems] = useState<AthleteWaiverRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [activeOnly, setActiveOnly] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/waiver-status`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: AthleteWaiverRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load waiver status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load waiver status.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const isLoading = items === null;

  const visible = useMemo(() => {
    if (isLoading) return [];
    return items
      .filter((row) => (activeOnly ? row.active_flag : true))
      .filter((row) => (filter === 'all' ? true : filter === 'complete' ? isComplete(row) : !isComplete(row)));
  }, [items, isLoading, filter, activeOnly]);

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--clinic min-h-screen">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          {/* Room DNA (clinic): cabinetry, the green banker's shade, and the
              blackletter reserved for the clinic masthead at display size only.
              The eyebrow states --brass-200 because --brass-400 is 3.34:1 on
              .mat-wood's lit edge; full note on /coach/sports-medicine. */}
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Admin Workspace</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Waiver Compliance
            </h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.waivers</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every athlete in the organization against every tracked waiver type -- general, medical release,
              photo &amp; media, travel -- so a missing waiver is visible without looking up athletes one at a
              time. Photo &amp; media consent has its own dedicated audit with guardian-level detail; that link
              is below.
            </p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Tonight is one answer per athlete. It follows training holds and medical clearance only.
              Papers, consent and open violations are listed under Also on file as they stand and do not
              change it.
            </p>
            {/* A failed read is a network fact. --locked red is what this room
                says when a clinician or a safeguarding decision has stopped
                something, so it does not carry this. --restricted does, keeping
                the glyph and gaining the uppercase label Law 3 asks for. */}
            {errorMessage ? (
              <div role="alert" className="alert alert--warning mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{errorMessage}</p>
                </div>
              </div>
            ) : null}
          </header>

          <div className="mt-[var(--s5)] flex flex-wrap items-center gap-[var(--s3)]">
            {(['incomplete', 'complete', 'all'] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`btn ${filter === value ? '' : 'btn--ghost'}`}
              >
                {value === 'incomplete' ? 'Missing a waiver' : value === 'complete' ? 'All signed' : 'All athletes'}
              </button>
            ))}
            <label className="t-body ml-[var(--s3)] flex items-center gap-[var(--s2)]">
              <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
              Active athletes only
            </label>
          </div>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The audit could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing in this view</div>
              <div className="empty-msg">No athletes match this filter right now.</div>
            </div>
          ) : (
            <section className="mat-leather mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)]">
              <table className="w-full text-left">
                <thead>
                  <tr className="t-eyebrow border-b border-[color:var(--hide-700)]">
                    <th className="px-[var(--s4)] py-[var(--s3)]">Athlete</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Tonight</th>
                    {TRACKED_WAIVER_TYPES.map((type) => (
                      <th key={type} className="px-[var(--s4)] py-[var(--s3)]">{WAIVER_TYPE_LABEL[type]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.athlete_id} className="border-b border-[color:var(--hide-800)] last:border-b-0">
                      <td className="t-body px-[var(--s4)] py-[var(--s3)]">{row.athlete_name}</td>
                      {/* A row with no answer sent is unavailable, never cleared. */}
                      <td className="px-[var(--s4)] py-[var(--s3)] align-top">
                        <span className={`badge ${TONIGHT_BADGE[row.tonight?.answer ?? 'unavailable'].rung}`}>
                          <i>{TONIGHT_BADGE[row.tonight?.answer ?? 'unavailable'].glyph}</i>
                          {TONIGHT_BADGE[row.tonight?.answer ?? 'unavailable'].label}
                        </span>
                        {row.tonight && contactClearanceLine(row.tonight) ? (
                          <p className="t-muted mt-[var(--s2)]">{contactClearanceLine(row.tonight)}</p>
                        ) : null}
                        {row.tonight ? (
                          <details className="mt-[var(--s2)]">
                            <summary
                              aria-label={`Why, ${row.athlete_name}`}
                              className="t-muted min-h-[44px] cursor-pointer py-[var(--s2)]"
                            >
                              Why
                            </summary>
                            <ul aria-label="Why" className="t-muted space-y-[var(--s2)]">
                              {tonightReasons(row.tonight).why.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                            <p className="t-eyebrow mt-[var(--s3)]">Also on file</p>
                            <ul aria-label="Also on file" className="t-muted mt-[var(--s2)] space-y-[var(--s2)]">
                              {tonightReasons(row.tonight).alsoOnFile.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </td>
                      {TRACKED_WAIVER_TYPES.map((type) => {
                        const status = row.waivers[type];
                        const ok = status === 'signed';
                        return (
                          <td key={type} className="px-[var(--s4)] py-[var(--s3)]">
                            <span className={`badge ${ok ? 'badge--cleared' : 'badge--restricted'}`}>
                              <i>{ok ? '✓' : '▲'}</i>
                              {status === 'signed' ? 'Signed' : status === 'declined' ? 'Declined' : status === 'withdrawn' ? 'Withdrawn' : 'Missing'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/admin/athlete-consent" className="btn btn--ghost">
              Photo &amp; Media Consent Audit
            </Link>
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
