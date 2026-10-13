"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateShort, gymDayIso } from '@/src/lib/gymTime';

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
  // No hold, and no medical clearance in force because none is on file, one is
  // pending or one has expired. Nobody decided "no contact" about this
  // athlete, so the answer does not say it: same rung and glyph as cleared,
  // with the medical clearance stated beside it as what is on file.
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
 * The line beside a "Cleared to train" answer: the medical clearance as it is
 * on file, a fact and not a prohibition. Only that answer carries it. It uses
 * the record's one name, the same as under "Why" and on /coach/sports-medicine:
 * two names in one cell read as two records.
 */
function contactClearanceLine(tonight: Tonight): string | null {
  if (tonight.answer !== 'cleared_to_train' || tonight.medical === 'unavailable') return null;
  return `Medical clearance: ${medicalWords(tonight.medical)}.`;
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

/*
 * RECORDING A PAPER WAIVER HERE (Jason 2026-10-12, OD-2026-10-12-009: "A: Yes,
 * build it"; Overwatch GO on #1526, Q1 A).
 *
 * The office records that a signed general, medical release or travel waiver
 * is on file, with the date on the paper and who signed it, and can withdraw
 * one. Both are a new row through the intake writer the register page already
 * uses (POST /api/pilot/intake/domain-upsert): rows are append-only and the
 * newest per type is current, so a withdrawal keeps the signed row as history,
 * and the server records who typed it (recorded_by_account_id) and writes the
 * audit event. Photo and media stays on its own consent audit, guardian by
 * guardian, and the server refuses it here too.
 *
 * Organization admin only: this page's gate is ['admin'], the client name for
 * an organization admin. Coaches keep the intake path they already have,
 * untouched (Q1 A).
 */
const RECORDABLE_TYPES: readonly TrackedWaiverType[] = ['general', 'medical_release', 'travel'];

/** Today as the gym's calendar day, the date field's default. */
function todayGymDay(): string {
  return gymDayIso(Date.now()) ?? '';
}

// The register page's vocabulary (/admin/consent). The office is a real
// answer for a withdrawal it makes itself -- a paper entered by mistake, or
// one that no longer stands -- so a withdrawal starts there (#1526 review).
const SIGNER_ROLES = [
  { value: 'guardian', label: 'Parent or legal guardian' },
  { value: 'athlete', label: 'Athlete (18 or over)' },
  { value: 'organization_admin', label: 'Gym administrator, on file' },
] as const;

interface WaiverEdit {
  athleteId: string;
  athleteName: string;
  type: TrackedWaiverType;
  action: 'record' | 'withdraw';
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
  const [edit, setEdit] = useState<WaiverEdit | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<string>('guardian');
  const [editNote, setEditNote] = useState('');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  // One write per press: two presses in one tick both read the same
  // editSaving, so the guard is a ref.
  const savingRef = useRef(false);

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

  function openEdit(next: WaiverEdit) {
    setEdit(next);
    setEditDate(todayGymDay());
    setEditName('');
    setEditRole(next.action === 'withdraw' ? 'organization_admin' : 'guardian');
    setEditNote('');
    setEditError('');
    setSavedMessage('');
  }

  async function saveEdit() {
    if (!edit || savingRef.current) return;
    if (!editName.trim()) {
      setEditError('Enter the name of the person who signed.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editDate)) {
      setEditError('Enter the date on the form.');
      return;
    }
    savingRef.current = true;
    setEditSaving(true);
    setEditError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'waiver',
          athlete_id: edit.athleteId,
          payload: {
            waiver_type: edit.type,
            status: edit.action === 'record' ? 'signed' : 'withdrawn',
            signed_by_name: editName.trim(),
            signed_by_role: editRole,
            // The column is a timestamp and the form gives a day: noon, so the
            // stored instant is that day in every timezone (as /admin/consent).
            signed_at: `${editDate}T12:00:00.000Z`,
            consent_version: 'v1',
            notes: editNote.trim(),
          },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'The waiver was not saved.');
      }
      setSavedMessage(
        `${PAPER_NAMES[edit.type]} for ${edit.athleteName}: ${edit.action === 'record' ? 'recorded as signed' : 'withdrawn'}.`,
      );
      setEdit(null);
      await load();
    } catch (error) {
      setEditError(error instanceof Error && error.message ? error.message : 'The waiver was not saved.');
    } finally {
      savingRef.current = false;
      setEditSaving(false);
    }
  }

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
          {/* Never nearer the edge than 73px: the shade is 89px and its pool of
              light 233px, centred, so 8% alone put the light past a phone's
              screen and widened the page (#1482 item 5). Unchanged above ~900px. */}
          <i aria-hidden="true" className="lamp lamp--green right-[max(8%,73px)]" />
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
            {savedMessage ? (
              <p role="status" className="t-body mt-[var(--s3)]">{savedMessage}</p>
            ) : null}
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
                        const recordable = RECORDABLE_TYPES.includes(type);
                        const editing = edit?.athleteId === row.athlete_id && edit.type === type;
                        const action: WaiverEdit['action'] = ok ? 'withdraw' : 'record';
                        return (
                          <td key={type} className="px-[var(--s4)] py-[var(--s3)] align-top">
                            <span className={`badge ${ok ? 'badge--cleared' : 'badge--restricted'}`}>
                              <i>{ok ? '✓' : '▲'}</i>
                              {status === 'signed' ? 'Signed' : status === 'declined' ? 'Declined' : status === 'withdrawn' ? 'Withdrawn' : 'Missing'}
                            </span>
                            {recordable && !editing ? (
                              <button
                                type="button"
                                onClick={() => openEdit({ athleteId: row.athlete_id, athleteName: row.athlete_name, type, action })}
                                aria-label={`${ok ? 'Withdraw' : 'Record signed'}: ${WAIVER_TYPE_LABEL[type]}, ${row.athlete_name}`}
                                className="btn btn--ghost mt-[var(--s2)] block"
                              >
                                {ok ? 'Withdraw' : 'Record signed'}
                              </button>
                            ) : null}
                            {editing && edit ? (
                              <div
                                role="group"
                                aria-label={`${edit.action === 'record' ? 'Record signed' : 'Withdraw'}: ${WAIVER_TYPE_LABEL[type]}, ${row.athlete_name}`}
                                className="mt-[var(--s2)] space-y-[var(--s2)]"
                              >
                                <label className="field">
                                  <span className="t-label">{edit.action === 'record' ? 'Date on the form' : 'Date withdrawn'}</span>
                                  <input type="date" value={editDate} onChange={(event) => setEditDate(event.target.value)} className="input" />
                                </label>
                                <label className="field">
                                  <span className="t-label">{edit.action === 'record' ? 'Signed by' : 'Withdrawn by'}</span>
                                  <input value={editName} onChange={(event) => setEditName(event.target.value)} className="input" />
                                </label>
                                <label className="field">
                                  <span className="t-label">They are the</span>
                                  <select value={editRole} onChange={(event) => setEditRole(event.target.value)} className="select">
                                    {SIGNER_ROLES.map((option) => (
                                      <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                  </select>
                                </label>
                                <label className="field">
                                  <span className="t-label">Note (optional)</span>
                                  <input value={editNote} onChange={(event) => setEditNote(event.target.value)} className="input" />
                                </label>
                                {editError ? <p role="alert" className="t-body">{editError}</p> : null}
                                <div className="flex flex-wrap gap-[var(--s2)]">
                                  <button type="button" onClick={() => void saveEdit()} disabled={editSaving} className="btn">
                                    {editSaving ? 'Saving…' : 'Save'}
                                  </button>
                                  <button type="button" onClick={() => setEdit(null)} disabled={editSaving} className="btn btn--ghost">
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
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
