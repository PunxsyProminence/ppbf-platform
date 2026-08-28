"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

interface GuardianConsentRow {
  parent_id: string;
  you: boolean;
  status: string | null;
  covers_video: boolean | null;
  public_use_allowed: boolean | null;
  signed_at: string | null;
}

interface AthleteConsent {
  athlete_id: string;
  athlete_name: string | null;
  consent_ok: boolean;
  guardian_count: number;
  missing_guardian_count: number;
  per_guardian: GuardianConsentRow[];
}

// A guardian deciding consent must know WHICH child they are acting on --
// the raw athlete_id is the fallback for a data gap, never the first choice.
function childLabel(item: Pick<AthleteConsent, 'athlete_id' | 'athlete_name'>): string {
  return item.athlete_name ?? item.athlete_id;
}

export default function GuardianMediaConsentPage() {
  const [items, setItems] = useState<AthleteConsent[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [videoByAthlete, setVideoByAthlete] = useState<Record<string, boolean>>({});
  const [publicByAthlete, setPublicByAthlete] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/consent`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: AthleteConsent[]; error?: string };
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

  async function decide(athleteId: string, decision: 'grant' | 'withdraw', childName: string) {
    if (decision === 'withdraw') {
      // Named, not generic: the confirmation is the last moment to catch a
      // wrong-child mistake, and withdrawal now immediately retracts this
      // child's published media.
      const confirmed = window.confirm(
        `Withdraw consent for ${childName}’s photos and videos? Anything already published of ${childName} will be retracted from distribution immediately, and future publications will be blocked until consent is granted again.`,
      );
      if (!confirmed) return;
    }

    setPendingIds((prev) => new Set(prev).add(athleteId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          decision,
          covers_video: decision === 'grant' ? (videoByAthlete[athleteId] ?? true) : undefined,
          public_use_allowed: decision === 'grant' ? (publicByAthlete[athleteId] ?? false) : undefined,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to record your decision.');
      }
      setActionMessage(decision === 'grant' ? 'Consent granted.' : 'Consent withdrawn.');
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to record your decision.');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(athleteId);
        return next;
      });
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['parent']}>
      {/* T7 (Plate Set v1): family surfaces take the warm ground or none.
          Gated to `parent`; see the note on parent/safety for why the room is
          dropped rather than swapped to .on-canvas. */}
      <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Guardian</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Photo &amp; Video Consent</h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Nothing here blocks your child from training. It controls one thing: whether photos or videos of your
              child may be used in gym publications. You can grant or withdraw consent at any time. If your child
              has more than one guardian, every guardian must consent before anything is published.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {actionMessage ? (
              <p role="status" className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p>
            ) : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">Consent status could not be loaded</div>
              <div className="empty-msg">Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">No linked children found</div>
              <div className="empty-msg">Contact the gym if this doesn&rsquo;t look right.</div>
            </div>
          ) : (
            <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              {items.map((item) => {
                const myRow = item.per_guardian.find((g) => g.you);
                // Normalised the same way the server now compares it
                // (guardianConsent.ts, owner decision 2026-08-28). The route
                // passes the raw stored string through, so without this a
                // guardian whose consent the server accepts would be told on
                // their own screen that they had not signed.
                const currentlySigned = (myRow?.status ?? '').trim().toLowerCase() === 'signed';
                return (
                  <article
                    key={item.athlete_id}
                    className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]"
                  >
                    <div className="flex items-center justify-between gap-[var(--s3)]">
                      <p className="t-eyebrow">{childLabel(item)}</p>
                      <span className={`badge ${item.consent_ok ? 'badge--cleared' : 'badge--restricted'}`}>
                        <i>{item.consent_ok ? '✓' : '▲'}</i>
                        {item.consent_ok ? 'Consent on file' : 'Consent needed'}
                      </span>
                    </div>
                    {item.guardian_count > 1 ? (
                      <p className="t-body mt-[var(--s2)]">
                        This child has {item.guardian_count} guardians. {item.missing_guardian_count} still need to
                        consent before anything can be published.
                      </p>
                    ) : null}
                    {!currentlySigned ? (
                      <div className="mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                        {/* THE LABEL IS THE TARGET, not the box. These two carried no
                            size class at all and rendered at the browser default --
                            about 13x13px, the smallest targets on the page, deciding
                            whether a minor's photograph goes on social media.

                            globals.css deliberately excludes checkboxes from its 44px
                            interactive floor ("a 44px checkbox is a layout bug, and
                            their labels are the real target"), so the fix is the one
                            that file already names: the wrapping <label> carries
                            --tap (55px) and stretches the full width of the card --
                            it is a flex item in a flex-col, so it stretches without
                            asking -- and the input stays a 21px (--s5) mark inside it.
                            Anywhere on the line toggles the box.

                            Unlike the button below, both of these utilities actually
                            win: nothing unlayered sets min-height on a <label> or
                            width/height on a checkbox, so there is no ppbf.css rule
                            for them to lose to. The same pattern is already on
                            /athlete/dashboard/sparring. */}
                        <label className="t-body flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)]">
                          <input
                            type="checkbox"
                            defaultChecked
                            className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                            onChange={(event) => setVideoByAthlete((prev) => ({ ...prev, [item.athlete_id]: event.target.checked }))}
                          />
                          Include video (unchecked = photos only)
                        </label>
                        <label className="t-body flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)]">
                          <input
                            type="checkbox"
                            className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                            onChange={(event) => setPublicByAthlete((prev) => ({ ...prev, [item.athlete_id]: event.target.checked }))}
                          />
                          Allow public use (website, social media) &mdash; unchecked means internal/gym use only
                        </label>
                      </div>
                    ) : null}
                    {/* .btn .btn--kiosk, not `.btn--lever min-h-[44px]`.

                        The old class string asked for 44px and rendered 38. It is
                        the #498 cascade trap: design-system/ppbf.css is UNLAYERED
                        and Tailwind's utilities sit in `@layer utilities`, and an
                        unlayered rule beats a layered one whatever the selectors
                        say -- so `.btn--lever { min-height: 38px }` won and the
                        utility did nothing. Adding a second utility here would have
                        looked like a fix and changed nothing; the height had to come
                        from a rule in the same unlayered sheet.

                        Both classes are that. `.btn` (ppbf.css) floors at 44px and
                        `.btn--kiosk` follows it at equal specificity, so the sheet's
                        own source order takes min-height to var(--tap) -- 55px, the
                        system's ergonomic token, which the README pairs with the
                        WCAG floor rather than with the gym floor. `.btn--kiosk` is
                        already the app's decisive-action scale on desk surfaces:
                        admin/escalations, admin/compliance-center and
                        admin/video-compliance all use it for confirm/cancel pairs.

                        NOT data-surface="kiosk". That attribute raises EVERY control
                        in a subtree, present and future, and globals.css scopes it to
                        the gym floor on purpose. A guardian on a phone is not a
                        kiosk, and this page needs two named controls raised, not a
                        blanket escalation it would inherit silently.

                        Full width comes with .btn--kiosk, and it is the point of
                        defect 3: "Back to Parent Hub" was 230x44 while this button
                        was 156x38, so the control that leaves without deciding was a
                        bigger target than the control that decides. It cannot be
                        again at any viewport -- this one spans the child's card, the
                        escape hatch keeps its intrinsic width. */}
                    <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s2)]">
                      {!currentlySigned ? (
                        <button
                          type="button"
                          disabled={pendingIds.has(item.athlete_id)}
                          onClick={() => void decide(item.athlete_id, 'grant', childLabel(item))}
                          className="btn btn--kiosk disabled:opacity-50"
                        >
                          Grant Consent
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={pendingIds.has(item.athlete_id)}
                          onClick={() => void decide(item.athlete_id, 'withdraw', childLabel(item))}
                          className="btn btn--kiosk disabled:opacity-50"
                        >
                          Withdraw Consent
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/parent/dashboard" className="btn btn--ghost">
              Back to Parent Hub
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
