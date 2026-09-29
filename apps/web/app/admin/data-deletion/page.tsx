"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RefusalStamp from '@/components/RefusalStamp';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/lib/gymTime';

/**
 * The screen over DELETE /api/pilot/admin/data-deletion.
 *
 * Jason, 2026-09-29, "10 C": scope A -- the person's record is marked deleted,
 * their login closes and anyone signed in as them is signed out -- and scope B:
 * everything tied to the athlete is marked deleted at the same moment
 * (dataDeletion.ts markAthleteTiedRecords, deletedAthletes.ts). Marked, not
 * erased: this screen says which, and says what B leaves where it was.
 *
 * The gate is 'admin' only: the API admits organization_admin and admin, which
 * are exactly the client role 'admin', and refuses platform_owner
 * (OD-2026-09-28-005). The organization is never sent from here; every route
 * this page calls takes it from the session.
 *
 * Every answer shown is the API's own. A count the server did not send reads
 * "not reported", never 0, and a failure never reads as a deletion.
 */

type EntityType = 'athlete' | 'guardian';

interface AthleteRow {
  athlete_id: string;
  full_name: string;
  // Not on PilotAthlete, but the admin list is SELECT * and the column exists.
  // Missing is read as "not deleted".
  deleted_at?: string | null;
}

interface MemberRow {
  account_id: string;
  login_email: string | null;
  role: string;
  active_flag: boolean;
  membership_active: boolean;
}

interface GuardianLinkRow {
  account_id: string;
  athlete_full_name: string;
}

interface Person {
  readonly id: string;
  /** Names the person, and is what the second confirmation says. */
  readonly label: string;
  /** Extra context in the picker only. */
  readonly note?: string;
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly people: Person[] }
  | { readonly status: 'failed'; readonly httpStatus: number | null; readonly message: string };

interface DeletionResult {
  deletedEntityType?: string;
  deletedEntityId?: string;
  deletedRecordsCounts?: {
    athletes?: number;
    accounts?: number;
    athleteVideos?: number;
    athletePhotos?: number;
    coachNotes?: number;
    sessionNotes?: number;
    shadowConversations?: number;
  };
  deletedAt?: string;
  auditEventId?: number;
}

type Outcome =
  | { readonly kind: 'done'; readonly entityType: EntityType; readonly person: Person; readonly result: DeletionResult | null }
  | { readonly kind: 'refused'; readonly httpStatus: number; readonly message: string }
  | { readonly kind: 'unknown' };

const NOT_REPORTED = 'not reported';

/**
 * RefusalStamp appends `detail` to its own sentence and adds the full stop, so
 * a message that already ends in one would double up. Same helper, same reason,
 * as SignInPanel.
 */
function trimTrailingPeriod(message: string): string {
  return message.endsWith('.') ? message.slice(0, -1) : message;
}

async function errorText(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error
    : `HTTP ${response.status}`;
}

function count(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : NOT_REPORTED;
}

function loginLine(accounts: number | undefined): string {
  if (accounts === 1) return 'closed and signed out everywhere';
  if (accounts === 0) return 'had no login';
  return NOT_REPORTED;
}

async function loadAthletes(): Promise<ListState> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
    if (!response.ok) {
      return { status: 'failed', httpStatus: response.status, message: await errorText(response) };
    }
    const body = (await response.json()) as { items?: AthleteRow[] };
    const people = (body.items ?? [])
      // Already-deleted athletes are hidden; the server refuses them anyway.
      .filter((row) => !row.deleted_at)
      .map((row) => ({ id: row.athlete_id, label: `${row.full_name} (${row.athlete_id})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { status: 'ready', people };
  } catch {
    return { status: 'failed', httpStatus: null, message: 'the athlete list could not be reached' };
  }
}

async function loadGuardians(): Promise<ListState> {
  try {
    const response = await fetch(`${apiBase()}/api/pilot/admin/staff`, { credentials: 'include' });
    if (!response.ok) {
      return { status: 'failed', httpStatus: response.status, message: await errorText(response) };
    }
    const body = (await response.json()) as { members?: MemberRow[]; guardian_links?: GuardianLinkRow[] };
    const links = body.guardian_links ?? [];
    const people = (body.members ?? [])
      .filter((member) => member.role === 'parent')
      .map((member) => {
        const children = links
          .filter((link) => link.account_id === member.account_id)
          .map((link) => link.athlete_full_name);
        const notes = [
          children.length > 0 ? `guardian of ${children.join(', ')}` : 'no linked children',
          // The staff list cannot tell a deleted guardian from one whose
          // sign-in was switched off; the server answers "already deleted"
          // if it is the first.
          ...(member.active_flag && member.membership_active ? [] : ['sign-in off']),
        ];
        return {
          id: member.account_id,
          label: `guardian ${member.login_email ?? member.account_id}`,
          note: notes.join('; '),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    return { status: 'ready', people };
  } catch {
    return { status: 'failed', httpStatus: null, message: 'the guardian list could not be reached' };
  }
}

function ListRefusal({ list, what }: { readonly list: ListState; readonly what: string }) {
  if (list.status !== 'failed') return null;
  if (list.httpStatus === 401) {
    return <RefusalStamp kind="signed_out" detail="sign in again, then reload this page" className="mt-[var(--s4)]" />;
  }
  return (
    <RefusalStamp
      kind="cannot_be_done"
      detail={`the ${what} list could not be read (${trimTrailingPeriod(list.message)})`}
      className="mt-[var(--s4)]"
    />
  );
}

function DataDeletionScreen() {
  const [athletes, setAthletes] = useState<ListState>({ status: 'loading' });
  const [guardians, setGuardians] = useState<ListState>({ status: 'loading' });
  const [entityType, setEntityType] = useState<EntityType | ''>('');
  const [personId, setPersonId] = useState('');
  const [reason, setReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function reloadLists() {
    const [nextAthletes, nextGuardians] = await Promise.all([loadAthletes(), loadGuardians()]);
    setAthletes(nextAthletes);
    setGuardians(nextGuardians);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [nextAthletes, nextGuardians] = await Promise.all([loadAthletes(), loadGuardians()]);
      if (cancelled) return;
      setAthletes(nextAthletes);
      setGuardians(nextGuardians);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const list = entityType === 'athlete' ? athletes : entityType === 'guardian' ? guardians : null;
  const people = list?.status === 'ready' ? list.people : [];
  const person = people.find((entry) => entry.id === personId) ?? null;
  const trimmedReason = reason.trim();
  const canReview = Boolean(entityType && person && trimmedReason) && !busy;

  async function submit() {
    if (!entityType || !person || !trimmedReason) return;
    setBusy(true);
    setOutcome(null);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/data-deletion`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityType, entityId: person.id, reason: trimmedReason }),
      });

      if (!response.ok) {
        setOutcome({ kind: 'refused', httpStatus: response.status, message: await errorText(response) });
      } else {
        const result = (await response.json().catch(() => null)) as DeletionResult | null;
        setOutcome({ kind: 'done', entityType, person, result });
        setPersonId('');
        setReason('');
      }
    } catch {
      // The request may or may not have reached the server. Say so; never
      // claim that nothing happened.
      setOutcome({ kind: 'unknown' });
    } finally {
      setReviewing(false);
      setBusy(false);
    }
    // Re-read both lists whatever the answer, so a deleted athlete drops out
    // of the picker and a stale list is not what the next choice is made from.
    await reloadLists();
  }

  return (
    /* data-surface="kiosk" -- Law 5: the 55px tap floor and the 19.1px type
       floor for every control and voice on the page. No room class: rooms
       were retired as a visual concept (2026-08-23) and may not spread
       (legacyVisualVocabulary.test.ts caps them); the door's `room` is
       structural metadata only. */
    <main data-surface="kiosk" className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Admin Workspace</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Data Deletion</h1>
          <p className="t-body max-w-3xl">
            Marks one athlete or one guardian account in your gym deleted. Their login closes and
            anyone signed in as them is signed out at once. Nothing is permanently removed from this
            screen.
          </p>
        </header>

        <section className="frame mt-[var(--s6)]">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather space-y-[var(--s4)] p-[var(--s5)]">
            <div className="field">
              <label className="t-label" htmlFor="deletion-type">Who is being deleted</label>
              <select
                id="deletion-type"
                className="select w-full"
                value={entityType}
                disabled={busy || reviewing}
                onChange={(event) => {
                  setEntityType(event.target.value as EntityType | '');
                  setPersonId('');
                  setOutcome(null);
                }}
              >
                <option value="">Choose athlete or guardian</option>
                <option value="athlete">An athlete</option>
                <option value="guardian">A guardian</option>
              </select>
            </div>

            {list?.status === 'loading' ? (
              <p><span className="working">Reading the list...</span></p>
            ) : null}
            {list ? <ListRefusal list={list} what={entityType === 'athlete' ? 'athlete' : 'guardian'} /> : null}

            {list?.status === 'ready' ? (
              people.length === 0 ? (
                <p className="t-muted">
                  {entityType === 'athlete'
                    ? 'No athletes on file who are not already deleted.'
                    : 'No guardian accounts on file.'}
                </p>
              ) : (
                <div className="field">
                  <label className="t-label" htmlFor="deletion-person">
                    {entityType === 'athlete' ? 'Athlete' : 'Guardian'}
                  </label>
                  <select
                    id="deletion-person"
                    className="select w-full"
                    value={personId}
                    disabled={busy || reviewing}
                    onChange={(event) => {
                      setPersonId(event.target.value);
                      setOutcome(null);
                    }}
                  >
                    <option value="">Choose one</option>
                    {people.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.note ? `${entry.label} — ${entry.note}` : entry.label}
                      </option>
                    ))}
                  </select>
                </div>
              )
            ) : null}

            <div className="field">
              <label className="t-label" htmlFor="deletion-reason">Reason (kept in the audit record)</label>
              <textarea
                id="deletion-reason"
                className="textarea w-full"
                rows={3}
                value={reason}
                disabled={busy || reviewing}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            {!reviewing ? (
              <button
                type="button"
                disabled={!canReview}
                onClick={() => {
                  setOutcome(null);
                  setReviewing(true);
                }}
                className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50"
              >
                Review deletion
              </button>
            ) : null}

            {reviewing && person && entityType ? (
              <div className="mat-leather--raised space-y-[var(--s3)] rounded-[var(--r-md)] p-[var(--s4)]" aria-live="polite">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Delete {person.label}?</h2>
                <p className="t-body">Second check. Pressing the button below does this at once:</p>
                <ul className="t-body space-y-[var(--s2)]">
                  {entityType === 'athlete' ? (
                    <>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        The athlete record is marked deleted.
                      </li>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        Their login is closed, and anyone signed in as them is signed out.
                      </li>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        Everything tied to them is marked deleted at the same moment: their videos and
                        what was made from them, their photo, coach notes, session notes, SHADOW
                        conversations, attendance, plans, entries and the rest. No screen shows it
                        after that. Nothing is erased; it stays in the database until permanent removal.
                      </li>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        Not changed: the admin safety screens (escalations, safety flags, training
                        holds, failing safety gates, video compliance, feedback) still show their items.
                      </li>
                    </>
                  ) : (
                    <>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        The guardian account is marked deleted, their login is closed, and anyone
                        signed in as them is signed out.
                      </li>
                      <li className="border-l-2 border-[color:var(--brass-700)] pl-[var(--s3)]">
                        Any linked child with no other guardian is withdrawn at the same moment: the
                        child&rsquo;s record is marked deleted, the child&rsquo;s own login is closed, and
                        everything tied to the child is marked deleted with them.
                      </li>
                    </>
                  )}
                </ul>
                <p className="t-body">
                  Reason recorded: <span className="t-data">{trimmedReason}</span>
                </p>
                <div className="flex flex-wrap gap-[var(--s3)]">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void submit();
                    }}
                    className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? 'Deleting...' : `Delete ${person.label}`}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setReviewing(false)}
                    className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Go back
                  </button>
                </div>
              </div>
            ) : null}

            {/* A 4xx is refused before the transaction commits (route.ts,
                dataDeletion.ts), so it is a refusal and nothing was deleted.
                A 5xx or a lost connection cannot promise that -- a failed
                COMMIT is ambiguous -- so neither is drawn as a refusal or told
                "nothing happened". */}
            {outcome?.kind === 'refused' && outcome.httpStatus < 500 ? (
              <div>
                {outcome.httpStatus === 401 ? (
                  <RefusalStamp kind="signed_out" detail="sign in again with Microsoft, then reload this page" />
                ) : (
                  <RefusalStamp kind="cannot_be_done" detail={trimTrailingPeriod(outcome.message)} />
                )}
                {outcome.httpStatus !== 409 ? (
                  <p className="t-body mt-[var(--s3)]">Nothing was deleted.</p>
                ) : null}
              </div>
            ) : null}

            {outcome?.kind === 'refused' && outcome.httpStatus >= 500 ? (
              <p className="t-body" role="status">
                The server answered with an error (HTTP {outcome.httpStatus}: {outcome.message}) and
                could not confirm the deletion. Reload this page before trying again; if it did go
                through, trying again is refused as already deleted.
              </p>
            ) : null}

            {outcome?.kind === 'unknown' ? (
              <p className="t-body" role="status">
                The screen could not tell whether the deletion went through. Reload this page before
                trying again; if it did go through, trying again is refused as already deleted.
              </p>
            ) : null}

            {outcome?.kind === 'done' ? (
              <div className="mat-leather--raised space-y-[var(--s2)] rounded-[var(--r-md)] p-[var(--s4)]" role="status">
                <p className="t-body">
                  ✓ Done: {outcome.person.label} is now marked deleted.
                  {outcome.result === null ? ' The server accepted it, but its answer could not be read.' : ''}
                </p>
                <dl className="t-body grid gap-[var(--s1)] sm:grid-cols-[auto_1fr] sm:gap-x-[var(--s4)]">
                  <dt>Marked deleted</dt>
                  <dd className="t-data">{formatGymStamp(outcome.result?.deletedAt) ?? NOT_REPORTED}</dd>
                  <dt>Login</dt>
                  <dd>{loginLine(outcome.result?.deletedRecordsCounts?.accounts)}</dd>
                  {outcome.entityType === 'guardian' ? (
                    <>
                      <dt>Children withdrawn with them</dt>
                      <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.athletes)}</dd>
                    </>
                  ) : null}
                  <dt>Videos marked deleted</dt>
                  <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.athleteVideos)}</dd>
                  <dt>Photos marked deleted</dt>
                  <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.athletePhotos)}</dd>
                  <dt>Coach notes marked deleted</dt>
                  <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.coachNotes)}</dd>
                  <dt>Session notes marked deleted</dt>
                  <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.sessionNotes)}</dd>
                  <dt>SHADOW conversations marked deleted</dt>
                  <dd className="t-data">{count(outcome.result?.deletedRecordsCounts?.shadowConversations)}</dd>
                  <dt>Audit record</dt>
                  <dd className="t-data">{count(outcome.result?.auditEventId)}</dd>
                </dl>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>What happens after</h2>
          <ul className="t-body mt-[var(--s3)] space-y-[var(--s2)]">
            <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
              The nightly cleanup is a dry run: it only reports what it would remove. Permanent
              removal happens only when someone dispatches the retention cleanup with APPLY, and only
              for records past their waiting period: 2 years after deletion for an athlete record,
              1 year for a guardian account.
            </li>
            <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
              Stored video and photo files are not erased, by this screen or by the permanent
              removal: neither one deletes a stored file. Whether the storage account removes them
              on its own has not been checked.
            </li>
            <li className="border-l-2 border-[color:var(--hide-600)] pl-[var(--s3)]">
              Every deletion is recorded with who did it, when, and the reason. A person already
              deleted cannot be deleted again; the screen says when they were.
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
  );
}

export default function DataDeletionPage() {
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <DataDeletionScreen />
    </RoleSessionGate>
  );
}
