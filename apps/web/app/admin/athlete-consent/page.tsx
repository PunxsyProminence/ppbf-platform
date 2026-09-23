"use client";

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationsLink from '@/components/OperationsLink';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface GuardianConsentRow {
  parent_id: string;
  parent_name: string;
  status: string | null;
  covers_video: boolean | null;
  public_use_allowed: boolean | null;
  signed_at: string | null;
}

interface OrganizationConsentRow {
  athlete_id: string;
  athlete_name: string;
  consent_ok: boolean;
  guardian_count: number;
  missing_guardian_count: number;
  per_guardian: GuardianConsentRow[];
}

type Filter = 'all' | 'missing' | 'ok';

export default function AthleteConsentAuditPage() {
  const [items, setItems] = useState<OrganizationConsentRow[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [filter, setFilter] = useState<Filter>('missing');
  // One row open at a time: recording a paper form is a deliberate act against
  // one named guardian, and several half-filled forms open at once is how the
  // wrong one gets submitted.
  const [openAthleteId, setOpenAthleteId] = useState<string | null>(null);
  const [selectedParentId, setSelectedParentId] = useState('');
  const [decision, setDecision] = useState<'grant' | 'withdraw'>('grant');
  // DEFAULTS CHECKED. Owner decision, and it is also the safe direction:
  // recording a consent that excludes video would REMOVE playback that works
  // today -- the video gate refuses a signed-but-photo-only guardian, while it
  // allows an athlete with no consent row at all.
  const [coversVideo, setCoversVideo] = useState(true);
  const [publicUseAllowed, setPublicUseAllowed] = useState(false);
  const [signedAt, setSignedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-consent`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: OrganizationConsentRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load consent status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load consent status.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  function openRecorder(item: OrganizationConsentRow) {
    setOpenAthleteId(item.athlete_id);
    // Preselect the first guardian still missing consent -- the one the person
    // holding the paper is most likely here about.
    const missing = item.per_guardian.find((g) => (g.status ?? '').trim().toLowerCase() !== 'signed');
    setSelectedParentId((missing ?? item.per_guardian[0])?.parent_id ?? '');
    setDecision('grant');
    setCoversVideo(true);
    setPublicUseAllowed(false);
    setSignedAt('');
    setNotes('');
    setFormError('');
  }

  async function submitConsent(athleteId: string) {
    setIsSaving(true);
    setFormError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          parent_id: selectedParentId,
          decision,
          // Real booleans, never strings: the API refuses a string by design,
          // because the string "false" once stored as full video consent.
          ...(decision === 'grant' ? { covers_video: coversVideo, public_use_allowed: publicUseAllowed } : {}),
          // The column is timestamptz and the input gives a calendar day. Noon
          // rather than midnight so the stored instant lands on the day that
          // was typed in every timezone this gym will ever be read from,
          // instead of the day before it west of Greenwich.
          ...(signedAt ? { signed_at: `${signedAt}T12:00:00.000Z` } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'That could not be recorded.');
      }
      setOpenAthleteId(null);
      // Re-read rather than patching local state: whether this athlete is now
      // cleared depends on EVERY guardian, which only the server knows.
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'That could not be recorded.');
    } finally {
      setIsSaving(false);
    }
  }

  const isLoading = items === null;
  const visible = isLoading
    ? []
    : items.filter((item) => (filter === 'all' ? true : filter === 'missing' ? !item.consent_ok : item.consent_ok));

  return (
    /* Advisory only -- the server gate on the route is the one that decides. */
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
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
              Guardian Media Consent Audit
            </h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.waivers</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every athlete in the organization and whether every one of their guardians has a current photo/video
              consent on file. An athlete with no guardians on file cannot have consent verified at all -- that
              shows as missing, not as cleared.
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

          <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
            {(['missing', 'ok', 'all'] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`btn ${filter === value ? '' : 'btn--ghost'}`}
              >
                {value === 'missing' ? 'Missing consent' : value === 'ok' ? 'Consent on file' : 'All athletes'}
              </button>
            ))}
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
                    <th className="px-[var(--s4)] py-[var(--s3)]">Guardians</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Status</th>
                    <th className="px-[var(--s4)] py-[var(--s3)]">Paper on file</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <Fragment key={item.athlete_id}>
                      <tr className="border-b border-[color:var(--hide-800)] last:border-b-0">
                        <td className="t-body px-[var(--s4)] py-[var(--s3)]">{item.athlete_name}</td>
                        <td className="t-body px-[var(--s4)] py-[var(--s3)]">
                          {item.guardian_count === 0
                            ? 'No guardians on file'
                            : `${item.guardian_count - item.missing_guardian_count}/${item.guardian_count} consented`}
                        </td>
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          <span className={`badge ${item.consent_ok ? 'badge--cleared' : 'badge--restricted'}`}>
                            <i>{item.consent_ok ? '✓' : '▲'}</i>
                            {item.consent_ok ? 'Consent on file' : 'Missing'}
                          </span>
                        </td>
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          {/* An athlete with no guardian links cannot have a
                              consent row recorded at all -- the write is
                              refused, because a consent has to belong to a
                              named guardian. Linking a guardian is an
                              organization_admin action on another screen, so a
                              coach seeing this cannot fix it here. */}
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={item.guardian_count === 0}
                            onClick={() => (openAthleteId === item.athlete_id ? setOpenAthleteId(null) : openRecorder(item))}
                          >
                            {item.guardian_count === 0
                              ? 'No guardian to record against'
                              : openAthleteId === item.athlete_id
                                ? 'Close'
                                : 'Record'}
                          </button>
                        </td>
                      </tr>
                      {openAthleteId === item.athlete_id ? (
                        <tr className="border-b border-[color:var(--hide-800)] last:border-b-0">
                          <td colSpan={4} className="px-[var(--s4)] py-[var(--s4)]">
                            <div className="flex flex-col gap-[var(--s3)]">
                              <p className="t-body">
                                Recording what a guardian signed on paper. The form itself stays in the office; this
                                records that it exists.
                              </p>

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Guardian
                                <select
                                  className="input"
                                  value={selectedParentId}
                                  onChange={(event) => setSelectedParentId(event.target.value)}
                                >
                                  {item.per_guardian.map((guardian) => (
                                    <option key={guardian.parent_id} value={guardian.parent_id}>
                                      {guardian.parent_name}
                                      {guardian.status ? ` — ${guardian.status}` : ' — nothing on file'}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Decision
                                <select
                                  className="input"
                                  value={decision}
                                  onChange={(event) => setDecision(event.target.value as 'grant' | 'withdraw')}
                                >
                                  <option value="grant">Consent signed</option>
                                  <option value="withdraw">Consent withdrawn</option>
                                </select>
                              </label>

                              {decision === 'grant' ? (
                                <>
                                  <label className="t-body flex items-center gap-[var(--s2)]">
                                    <input
                                      type="checkbox"
                                      checked={coversVideo}
                                      onChange={(event) => setCoversVideo(event.target.checked)}
                                    />
                                    The form covers video
                                  </label>
                                  <label className="t-body flex items-center gap-[var(--s2)]">
                                    <input
                                      type="checkbox"
                                      checked={publicUseAllowed}
                                      onChange={(event) => setPublicUseAllowed(event.target.checked)}
                                    />
                                    The form allows public use
                                  </label>
                                </>
                              ) : null}

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Date on the form (optional)
                                <input
                                  type="date"
                                  className="input"
                                  value={signedAt}
                                  onChange={(event) => setSignedAt(event.target.value)}
                                />
                              </label>

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Where the paper is held (optional)
                                <input
                                  type="text"
                                  className="input"
                                  value={notes}
                                  onChange={(event) => setNotes(event.target.value)}
                                />
                              </label>

                              {/* A CODE FACT, not a caution: consent is cleared
                                  only when EVERY linked guardian has a current
                                  signature, so on an athlete with two guardians
                                  this row stays Missing until the second one is
                                  recorded too. */}
                              {item.guardian_count > 1 ? (
                                <p className="t-body">
                                  This athlete has {item.guardian_count} guardians. Consent reads as on file only once
                                  every one of them is recorded.
                                </p>
                              ) : null}

                              {formError ? (
                                <div role="alert" className="alert alert--warning">
                                  <span className="alert-icon" aria-hidden="true">▲</span>
                                  <div className="alert-body">
                                    <p className="alert-title">Attention</p>
                                    <p className="alert-msg">{formError}</p>
                                  </div>
                                </div>
                              ) : null}

                              <div className="flex flex-wrap gap-[var(--s3)]">
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={isSaving || selectedParentId === ''}
                                  onClick={() => {
                                    void submitConsent(item.athlete_id);
                                  }}
                                >
                                  {isSaving ? 'Recording…' : 'Record'}
                                </button>
                                <button type="button" className="btn btn--ghost" onClick={() => setOpenAthleteId(null)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/admin/video-compliance" className="btn btn--ghost">
              Video Compliance Review
            </Link>
            {/* Not a raw Link any more: this page now admits coach, and a
                coach opening /operations is bounced by the hub's own gate.
                OperationsLink renders nothing for a role that would be
                refused, which is the honest treatment -- a link that leads to
                a refusal reads as a broken button. */}
            <OperationsLink className="btn btn--ghost">
              Back to Mission Control
            </OperationsLink>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
