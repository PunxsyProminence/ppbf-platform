"use client";

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import OperationsLink from '@/components/OperationsLink';
import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

interface GuardianConsentRow {
  parent_id: string;
  parent_name: string;
  /* false = a guardian who exists only as a name on paper: no login, no
     email, never sees the parent console. Labelled wherever the name shows,
     so nobody waits for this guardian to "sign in and do it themselves". */
  has_login: boolean;
  status: string | null;
  /* Whether this guardian counts as consented, decided by the server with the
     same normalisation the consent gates use. This screen must never re-derive
     it from `status`: that would be a second copy of the rule, and a second
     copy is how a padded ' Signed ' once read as a signature to one reader and
     as nothing to another. `status` is here to be DISPLAYED, not compared. */
  consented: boolean;
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

/**
 * pilot.guardian_links.relationship_to_athlete is plain text; this is the
 * same fixed list the people console's guardian invite offers, so the two
 * entry points write the same words for the same relationship.
 */
const GUARDIAN_RELATIONSHIPS = [
  { value: 'mother', label: 'Mother' },
  { value: 'father', label: 'Father' },
  { value: 'guardian', label: 'Legal guardian' },
  { value: 'grandparent', label: 'Grandparent' },
  { value: 'other', label: 'Other family member' },
];

/** A guardian's name as the picker and the cell show it. */
function guardianLabel(guardian: GuardianConsentRow): string {
  return guardian.has_login ? guardian.parent_name : `${guardian.parent_name} (paper only)`;
}

export default function AthleteConsentAuditPage() {
  /* Advisory, like the page gate: the server refuses a coach's guardian
     write regardless. Read so the control is not offered to a role that
     would only ever see it refused. */
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const canAddGuardian = session?.role === 'admin';

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

  /* THE PAPER-ONLY GUARDIAN (Jason 2026-10-07, OD-2026-10-07-009, "Yes, name
     and relationship"): a guardian record with no login, so a family that
     deals with the gym on paper can have its consent recorded against a
     named guardian. One form open at a time, for the same reason as the
     recorder above. */
  const [addingForAthleteId, setAddingForAthleteId] = useState<string | null>(null);
  const [newGuardianName, setNewGuardianName] = useState('');
  const [newGuardianRelationship, setNewGuardianRelationship] = useState(GUARDIAN_RELATIONSHIPS[0].value);
  // Set when a guardian with the same name is already linked: the add waits
  // for a second press, so a form entered twice does not make two records.
  const [sameNameConfirmed, setSameNameConfirmed] = useState(false);
  const [addError, setAddError] = useState('');
  const [addNotice, setAddNotice] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Returns what it loaded, so a caller that needs the fresh rows (the
  // guardian add below) does not have to wait for a render to see them.
  const load = useCallback(async (): Promise<OrganizationConsentRow[] | null> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-consent`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: OrganizationConsentRow[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load consent status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
      return payload.items ?? [];
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load consent status.');
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  function openRecorder(item: OrganizationConsentRow, preferParentId?: string) {
    setOpenAthleteId(item.athlete_id);
    setAddingForAthleteId(null);
    // Preselect the guardian just added, else the first guardian still
    // missing consent -- the one the person holding the paper is most likely
    // here about.
    const preferred = preferParentId ? item.per_guardian.find((g) => g.parent_id === preferParentId) : undefined;
    const missing = item.per_guardian.find((g) => !g.consented);
    setSelectedParentId((preferred ?? missing ?? item.per_guardian[0])?.parent_id ?? '');
    setDecision('grant');
    setCoversVideo(true);
    setPublicUseAllowed(false);
    setSignedAt('');
    setNotes('');
    setFormError('');
  }

  function openGuardianForm(item: OrganizationConsentRow) {
    setAddingForAthleteId(item.athlete_id);
    setOpenAthleteId(null);
    setNewGuardianName('');
    setNewGuardianRelationship(GUARDIAN_RELATIONSHIPS[0].value);
    setSameNameConfirmed(false);
    setAddError('');
    setAddNotice('');
  }

  /** Guardians already linked to this athlete under the typed name. */
  function sameNameGuardians(item: OrganizationConsentRow): GuardianConsentRow[] {
    const typed = newGuardianName.trim().toLowerCase();
    return typed ? item.per_guardian.filter((g) => g.parent_name.trim().toLowerCase() === typed) : [];
  }

  async function submitGuardian(item: OrganizationConsentRow) {
    const fullName = newGuardianName.trim();
    if (!fullName) return;
    if (sameNameGuardians(item).length > 0 && !sameNameConfirmed) {
      // First press on a duplicate name only arms the confirmation.
      setSameNameConfirmed(true);
      return;
    }
    setIsAdding(true);
    setAddError('');
    /* The id is minted here because the write below takes one and this
       record has no account to derive one from (an invited guardian's is
       par-<account id>, staffProvisioning.ts). pilot.parents.parent_id is
       plain text with no convention the readers depend on; the "paper"
       infix keeps it out of the par-<account> space and legible in an audit
       row. */
    const parentId = `par-paper-${crypto.randomUUID()}`;
    try {
      /* THE SAME WRITE INTAKE USES, not a second one: domain-upsert's
         guardian_link (organization_admin only) creates the pilot.parents row
         with no account and no email and the guardian_links row under the
         consent-set lock, in one transaction, audited. Nothing can sign in
         as this guardian and no invite can claim the record by accident,
         because there is no address to match. */
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'guardian_link',
          athlete_id: item.athlete_id,
          payload: { parent_id: parentId, full_name: fullName, relationship_to_athlete: newGuardianRelationship },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'That guardian could not be added.');
      }
      setAddingForAthleteId(null);
      setAddNotice(`${fullName} is now a paper-only guardian of ${item.athlete_name}. Record what they signed below.`);
      // Re-read, then open the recorder on the new guardian so the consent is
      // filed next -- the reason the record was made.
      const fresh = await load();
      const refreshed = fresh?.find((row) => row.athlete_id === item.athlete_id);
      if (refreshed?.per_guardian.some((g) => g.parent_id === parentId)) {
        openRecorder(refreshed, parentId);
      }
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'That guardian could not be added.');
    } finally {
      setIsAdding(false);
    }
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
      // RE-READ EVEN ON FAILURE. A consent change and its takedown of published
      // video now commit together or not at all, so a 500 normally means
      // nothing changed; re-reading anyway keeps the table on what the server
      // holds rather than on what this screen assumed. The refusals that wrote
      // nothing simply re-read the same state.
      await load();
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
            {/* The register at /admin/consent no longer files photo and media
                consent (OD-2026-10-07-009); the people arriving from its
                pointer need to know they are in the right place. */}
            <p className="t-body mt-[var(--s2)] max-w-4xl">
              This is the only place photo and video consent is recorded. A guardian who has no login is shown as
              &ldquo;paper only&rdquo;; their consent is recorded here from the signed form, the same as anyone else&rsquo;s.
            </p>
            {addNotice ? (
              <div role="status" className="alert alert--success mt-[var(--s3)]">
                <span className="alert-icon" aria-hidden="true">✓</span>
                <div className="alert-body">
                  <p className="alert-title">Guardian added</p>
                  <p className="alert-msg">{addNotice}</p>
                </div>
              </div>
            ) : null}
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
                          {/* Who they are, with the paper-only ones marked:
                              a count alone cannot say which guardian is the
                              one nobody can email. */}
                          {item.per_guardian.length > 0 ? (
                            <span className="block text-[length:var(--t-xs)] text-[color:var(--bone-400)]">
                              {item.per_guardian.map(guardianLabel).join(' · ')}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          <span className={`badge ${item.consent_ok ? 'badge--cleared' : 'badge--restricted'}`}>
                            <i>{item.consent_ok ? '✓' : '▲'}</i>
                            {item.consent_ok ? 'Consent on file' : 'Missing'}
                          </span>
                        </td>
                        <td className="px-[var(--s4)] py-[var(--s3)]">
                          <div className="flex flex-wrap gap-[var(--s2)]">
                            {/* An athlete with no guardian links cannot have a
                                consent row recorded at all -- the write is
                                refused, because a consent has to belong to a
                                named guardian. An organization admin adds the
                                guardian with the control beside this one; a
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
                            {canAddGuardian ? (
                              <button
                                type="button"
                                className="btn btn--ghost"
                                onClick={() => (addingForAthleteId === item.athlete_id ? setAddingForAthleteId(null) : openGuardianForm(item))}
                              >
                                {addingForAthleteId === item.athlete_id ? 'Close' : 'Add paper-only guardian'}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {addingForAthleteId === item.athlete_id ? (
                        <tr className="border-b border-[color:var(--hide-800)] last:border-b-0">
                          <td colSpan={4} className="px-[var(--s4)] py-[var(--s4)]">
                            <div className="flex flex-col gap-[var(--s3)]">
                              <p className="t-body">
                                Adding a guardian of {item.athlete_name} who deals with the gym on paper. They get no
                                login and no email: their consent is recorded here from the form they sign. If this
                                person will sign in, invite them from People instead.
                              </p>

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Guardian&rsquo;s full name
                                <input
                                  type="text"
                                  className="input"
                                  value={newGuardianName}
                                  onChange={(event) => {
                                    setNewGuardianName(event.target.value);
                                    setSameNameConfirmed(false);
                                  }}
                                />
                              </label>

                              <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                                Relationship to {item.athlete_name}
                                <select
                                  className="input"
                                  value={newGuardianRelationship}
                                  onChange={(event) => setNewGuardianRelationship(event.target.value)}
                                >
                                  {GUARDIAN_RELATIONSHIPS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                              </label>

                              {/* A second record for a guardian already linked
                                  would mean two consents to collect from one
                                  person. Shown and confirmed, not refused: two
                                  guardians can share a name. */}
                              {sameNameGuardians(item).length > 0 ? (
                                <div role="alert" className="alert alert--warning">
                                  <span className="alert-icon" aria-hidden="true">▲</span>
                                  <div className="alert-body">
                                    <p className="alert-title">Already linked</p>
                                    <p className="alert-msg">
                                      {sameNameGuardians(item).map(guardianLabel).join(', ')} is already a guardian of{' '}
                                      {item.athlete_name}. Adding again makes a second record, and both would need to sign.
                                      {sameNameConfirmed ? ' Press “Add anyway” to add a second guardian with this name.' : ''}
                                    </p>
                                  </div>
                                </div>
                              ) : null}

                              {addError ? (
                                <div role="alert" className="alert alert--warning">
                                  <span className="alert-icon" aria-hidden="true">▲</span>
                                  <div className="alert-body">
                                    <p className="alert-title">Attention</p>
                                    <p className="alert-msg">{addError}</p>
                                  </div>
                                </div>
                              ) : null}

                              <div className="flex flex-wrap gap-[var(--s3)]">
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={isAdding || newGuardianName.trim() === ''}
                                  onClick={() => {
                                    void submitGuardian(item);
                                  }}
                                >
                                  {isAdding ? 'Adding…' : sameNameConfirmed ? 'Add anyway' : 'Add guardian'}
                                </button>
                                <button type="button" className="btn btn--ghost" onClick={() => setAddingForAthleteId(null)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
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
                                      {guardianLabel(guardian)}
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
