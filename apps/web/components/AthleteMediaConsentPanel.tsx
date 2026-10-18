'use client';

import { useId, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// The adult athlete's own photo and video consent (OD-2026-10-08-015: at 18 a
// guardian's consent stops counting for anything new, and the athlete decides
// for themselves). It talks only to /api/pilot/athlete/media-consent, which
// only the athlete reaches, for their own record. Copy PROPOSED.
//
// CLOSED UNTIL TAPPED, like the cycle card: this sits on a screen that may be
// a shared tablet, so it reads nothing until the athlete opens it, and
// closing it drops what it read.

interface ConsentView {
  is_adult: boolean;
  consent: { status: string; covers_video: boolean; public_use_allowed: boolean; recorded_at: string } | null;
  counts_for_new_publication: boolean;
  retracted_publication_ids?: string[];
}

const SCOPE_LINE = 'This is about photos and video of you that the gym uses: the research library, and anything shared outside the gym.';

/** What is on file, in the athlete's words. */
export function currentWords(view: ConsentView): string {
  const consent = view.consent;
  if (consent === null) {
    return "You haven't decided yet. Until you do, no new video of you is published. Anything already published stays as it is.";
  }
  const status = consent.status.trim().toLowerCase();
  if (status === 'withdrawn') return 'You said no. Nothing new of you is published.';
  if (status === 'signed' && !consent.covers_video) return 'You said yes to photos only. No new video of you is published.';
  if (view.counts_for_new_publication) {
    return consent.public_use_allowed
      ? 'You said yes to photos and video, including use outside the gym (website, social media, print).'
      : 'You said yes to photos and video, for use inside the gym only.';
  }
  return 'Your answer on file could not be read. Choose again below.';
}

/** A refusal from the server, said plainly; anything unknown is "not saved". */
function refusalWords(payload: { code?: unknown } | null): string {
  if (payload?.code === 'ATHLETE_NOT_ADULT') return 'Until you are 18, your guardian decides this. Nothing was saved.';
  if (payload?.code === 'NOT_OWN_LOGIN') return 'Only you, signed in as yourself, can change this. Nothing was saved.';
  return 'That was not saved. Try again.';
}

export default function AthleteMediaConsentPanel() {
  const headingId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConsentView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [coversVideo, setCoversVideo] = useState(true);
  const [publicUse, setPublicUse] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  // The choices start at what is on file, so saving without touching them changes nothing.
  const showAnswer = (next: ConsentView) => {
    setView(next);
    if (next.consent && next.consent.status.trim().toLowerCase() === 'signed') {
      setCoversVideo(next.consent.covers_video);
      setPublicUse(next.consent.public_use_allowed);
    }
  };

  const load = async () => {
    setLoadFailed(false);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/media-consent`, { credentials: 'include' });
      if (!response.ok) throw new Error('read failed');
      showAnswer((await response.json()) as ConsentView);
    } catch {
      setLoadFailed(true);
    }
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      setView(null);
      setConfirmWithdraw(false);
      setError('');
      setSaved('');
      return;
    }
    setOpen(true);
    void load();
  };

  const send = async (body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/media-consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as (ConsentView & { code?: unknown }) | null;
      if (response.status >= 400 && response.status < 500) {
        setError(refusalWords(payload));
        await load();
        return;
      }
      if (!response.ok || payload === null) {
        // A 5xx or a lost reply: whether it saved is unknown, so say so and read again.
        setError("We couldn't confirm that was saved. Check what's shown below before trying again.");
        await load();
        return;
      }
      showAnswer(payload);
      setConfirmWithdraw(false);
      const taken = payload.retracted_publication_ids?.length ?? 0;
      setSaved(`Saved.${taken > 0 ? ` ${taken} published video${taken === 1 ? ' was' : 's were'} taken down.` : ''}`);
      toggleRef.current?.focus();
    } catch {
      setError("We couldn't confirm that was saved. Check what's shown below before trying again.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-[var(--s3)]" aria-labelledby={headingId}>
      <h3 className="t-label" id={headingId}>
        <button
          ref={toggleRef}
          type="button"
          className="btn btn--ghost"
          aria-expanded={open}
          onClick={toggle}
        >
          Photos and video of me
        </button>
      </h3>

      {open && (
        <>
          {loadFailed && (
            <div className="flex items-center gap-[var(--s2)]">
              <p className="t-data" role="alert">That didn&apos;t load.</p>
              <button type="button" className="btn btn--ghost" onClick={() => void load()}>Try again</button>
            </div>
          )}

          {view && !view.is_adult && (
            <p className="t-data">
              Until you are 18, your guardian decides whether photos and video of you can be used. From your 18th
              birthday you decide here yourself.
            </p>
          )}

          {view?.is_adult && (
            <>
              <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-300)' }}>{SCOPE_LINE}</p>
              <p className="t-data" data-testid="media-consent-current">{currentWords(view)}</p>

              <fieldset className="space-y-[var(--s2)]">
                <legend className="t-label">What may the gym use?</legend>
                <label className="flex items-center gap-[var(--s2)]">
                  <input type="radio" name="media-scope" checked={coversVideo} onChange={() => setCoversVideo(true)} />
                  <span className="t-data">Photos and video</span>
                </label>
                <label className="flex items-center gap-[var(--s2)]">
                  <input type="radio" name="media-scope" checked={!coversVideo} onChange={() => setCoversVideo(false)} />
                  <span className="t-data">Photos only</span>
                </label>
                <label className="flex items-center gap-[var(--s2)]">
                  <input type="checkbox" checked={publicUse} onChange={(event) => setPublicUse(event.target.checked)} />
                  <span className="t-data">Also outside the gym (website, social media, print)</span>
                </label>
                {!coversVideo && (
                  <p style={{ fontSize: 'var(--t-sm)', color: 'var(--bone-300)' }}>
                    Photos only takes down any video of you that is already published.
                  </p>
                )}
              </fieldset>
              <button
                type="button"
                className="btn btn--kiosk"
                disabled={busy}
                onClick={() => void send({ decision: 'grant', covers_video: coversVideo, public_use_allowed: publicUse })}
              >
                Save my answer
              </button>

              {view.consent?.status.trim().toLowerCase() !== 'withdrawn' && (
                confirmWithdraw ? (
                  <div className="space-y-[var(--s2)]" role="group" aria-label="Say no to photos and video">
                    <p className="t-data">Saying no takes down your published videos, and nothing new of you is published.</p>
                    <div className="flex gap-[var(--s2)]">
                      <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void send({ decision: 'withdraw' })}>
                        Say no and take them down
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={() => { setConfirmWithdraw(false); toggleRef.current?.focus(); }}>
                        Keep my answer
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmWithdraw(true)}>
                    Say no to all photos and video
                  </button>
                )
              )}
            </>
          )}

          {saved !== '' && <p className="t-data" role="status">{saved}</p>}
          {error !== '' && <p className="t-data" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
