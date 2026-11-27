'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import Chalkboard from '@/components/Chalkboard';
import type { AnnouncementPlacement } from '@/components/AnnouncementBanner';
import GymProfileForm from '@/components/GymProfileForm';
import GymTabletSettings from '@/components/GymTabletSettings';
import StoppedComingSettings from '@/components/StoppedComingSettings';
import EmailAlertSettings from '@/components/admin/EmailAlertSettings';
import { useOrganizationProfile } from '@/components/OrganizationProfileProvider';
import { GYM_PHOTO_SLOTS, gymPhotoSlotText, gymPhotoSrc } from '@/src/shared/gymPhotos';
import { apiBase } from '@/lib/apiBase';
import { usePilotSession } from '@/components/usePilotSession';
import BackHome from '@/components/BackHome';

/**
 * THE CUSTOMIZATION CENTER -- everything the gym can change about how it looks
 * and sounds, on one page in the office.
 *
 * One desk, seven drawers:
 *
 *   0. THE GYM PROFILE. The stored profile every page reads, edited here
 *      (lane L31 P3).
 *
 *   1. PHOTOGRAPHS. The six wall frames from src/shared/gymPhotos.ts. Each
 *      holds a commissioned placeholder illustration today; a photograph
 *      uploaded here is stored org-scoped in private blob storage (EXIF/GPS
 *      stripped server-side) and takes the frame everywhere the slot appears
 *      on signed-in surfaces. Removing it puts the illustration back. The
 *      release rule is a person who can see the picture deciding it goes up.
 *
 *   2. THE BOARDS. The chalk lines members see on their dashboards, writable
 *      here with the same component that draws them -- no new storage, the
 *      same pilot.announcements rows /notices manages. Writing on a board
 *      rubs out what was there; windows and retiring live on /notices, which
 *      shows the 25 most recent notices rather than the whole history.
 *
 *   3. THE GYM TABLET. How long a marked gym tablet may sit idle before it
 *      signs itself out (OW25-53 A), and the mark for this device (lane U1).
 *
 *   4. STOPPED COMING. How long without coming puts an athlete on the
 *      Stopped Coming list (OW27-30 A; lane W4-6, SC-0b).
 *
 *   5. EMAIL ALERTS. Which events may send the opt-in email alert to each
 *      kind of person (OW27-10 A, OW27-39 A; lane W4-1, EM-6).
 *
 *   6. THE RECORD. Links to the surfaces that keep history -- notices with
 *      their lifecycle, and the boards' own desk page.
 *
 * The server is the real gate on every drawer: photo writes require an admin
 * role, board writes require a Microsoft-authenticated staff principal, and
 * this page can widen neither.
 */

type SlotBusy = 'idle' | 'uploading' | 'removing';

interface SlotNotice {
  readonly tone: 'ok' | 'error';
  readonly text: string;
}

const BOARDS: ReadonlyArray<{ placement: AnnouncementPlacement; where: string; who: string }> = [
  {
    placement: 'everywhere',
    where: 'Everywhere',
    who: 'Every board at once — athletes, coaches, parents, and the paired gym TV.',
  },
  {
    placement: 'athlete_workspace',
    where: 'The athletes’ board',
    who: 'On every athlete’s own dashboard, under their fight card.',
  },
  {
    placement: 'coach_workspace',
    where: 'The coaches’ board',
    who: 'Shown on the coaches’ workspace.',
  },
  {
    placement: 'parent_hub',
    where: 'The parents’ board',
    who: 'Shown on the parent hub, for guardians.',
  },
];

export default function AdminCustomizePage() {
  const gym = useOrganizationProfile();
  const pilotSession = usePilotSession();
  const isPlatformOwner = pilotSession.role === 'platform_owner';
  const [access, setAccess] = useState<'checking' | 'allowed' | 'denied'>('checking');
  const [uploaded, setUploaded] = useState<ReadonlySet<string>>(new Set());
  // Bumped per slot on upload so the <img> re-fetches past the browser cache.
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<Record<string, SlotBusy>>({});
  const [notices, setNotices] = useState<Record<string, SlotNotice>>({});
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    // The photo route refuses the platform owner (OD-2026-10-08-003): it gets
    // the same notice without the request. Nothing is asked before the
    // session is read.
    if (pilotSession.loading || isPlatformOwner) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/gym-photos`, { credentials: 'include' });
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          setAccess('denied');
          return;
        }
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data: { ok?: boolean; uploaded?: string[] } = await response.json();
        setUploaded(new Set(data.uploaded ?? []));
        setAccess('allowed');
      } catch {
        if (!cancelled) setAccess('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pilotSession.loading, isPlatformOwner]);

  const setSlotNotice = useCallback((slotKey: string, notice: SlotNotice | null) => {
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[slotKey] = notice;
      else delete next[slotKey];
      return next;
    });
  }, []);

  const upload = useCallback(async (slotKey: string) => {
    const input = fileInputs.current[slotKey];
    const file = input?.files?.[0];
    if (!file) {
      setSlotNotice(slotKey, { tone: 'error', text: 'Choose a photograph first.' });
      return;
    }
    setBusy((current) => ({ ...current, [slotKey]: 'uploading' }));
    setSlotNotice(slotKey, null);
    try {
      const body = new FormData();
      body.append('slot', slotKey);
      body.append('photo', file);
      const response = await fetch(`${apiBase()}/api/pilot/admin/gym-photos`, { method: 'POST', body, credentials: 'include' });
      const data: { ok?: boolean; error?: string; message?: string } = await response.json();
      if (!response.ok || !data.ok) {
        setSlotNotice(slotKey, { tone: 'error', text: data.error ?? 'The upload failed. Try again.' });
        return;
      }
      setUploaded((current) => new Set([...current, slotKey]));
      setVersions((current) => ({ ...current, [slotKey]: (current[slotKey] ?? 0) + 1 }));
      if (input) input.value = '';
      setSlotNotice(slotKey, { tone: 'ok', text: data.message ?? 'On the wall.' });
    } catch {
      setSlotNotice(slotKey, { tone: 'error', text: 'The upload failed. Try again.' });
    } finally {
      setBusy((current) => ({ ...current, [slotKey]: 'idle' }));
    }
  }, [setSlotNotice]);

  const remove = useCallback(async (slotKey: string) => {
    setBusy((current) => ({ ...current, [slotKey]: 'removing' }));
    setSlotNotice(slotKey, null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/gym-photos?slot=${encodeURIComponent(slotKey)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data: { ok?: boolean; error?: string } = await response.json();
      if (!response.ok || !data.ok) {
        setSlotNotice(slotKey, { tone: 'error', text: data.error ?? 'Could not take it down. Try again.' });
        return;
      }
      setUploaded((current) => {
        const next = new Set(current);
        next.delete(slotKey);
        return next;
      });
      setSlotNotice(slotKey, { tone: 'ok', text: 'Taken down. The placeholder illustration is back in the frame.' });
    } catch {
      setSlotNotice(slotKey, { tone: 'error', text: 'Could not take it down. Try again.' });
    } finally {
      setBusy((current) => ({ ...current, [slotKey]: 'idle' }));
    }
  }, [setSlotNotice]);

  // The platform owner is shown the notice straight away (see the effect).
  const shownAccess = isPlatformOwner ? 'denied' : access;

  if (shownAccess === 'checking') {
    return (
      <main className="room room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
        <p className="working">Opening the customization drawer</p>
      </main>
    );
  }

  if (shownAccess === 'denied') {
    return (
      <main className="room room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
        <div className="mat-leather max-w-[610px] p-[var(--s5)]">
          <p className="t-eyebrow">Customize the gym</p>
          <p className="t-body mt-[var(--s3)]">
            <span className="badge badge--restricted"><span aria-hidden="true">▲</span> ADMINS ONLY</span>
          </p>
          <p className="t-muted mt-[var(--s3)]">
            Changing how the gym looks is an administrator&apos;s decision. Ask your organization admin.
          </p>
          <BackHome className="btn btn--ghost mt-[var(--s4)]" />
        </div>
      </main>
    );
  }

  return (
    <main className="room room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
      <header className="mat-leather max-w-[1000px] p-[var(--s5)]">
        <p className="t-eyebrow">Customize the gym</p>
        <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
          Customize the Gym
        </h1>
        <p className="t-body mt-[var(--s3)] max-w-[68ch]">
          Photographs on the wall, the chalk on the boards, and the notices — everything the gym shows
          its members, changed from here. Every drawer below writes through the same doors the rest of
          the platform already guards.
        </p>
        {/* Lane BT, BOA-12: a short index of this page, each entry the heading it
            jumps to, then Quotes (that page's title). Quotes opens for the same
            people this desk does: its gate is ['admin'] (organization admin and
            admin), as the photo route that opens this desk is. */}
        <nav aria-label="On this page" className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
          <a href="#customize-profile" className="btn btn--ghost">The gym&apos;s profile</a>
          <a href="#customize-photos" className="btn btn--ghost">Photographs on the wall</a>
          <a href="#customize-boards" className="btn btn--ghost">The boards</a>
          <a href="#customize-tablet" className="btn btn--ghost">Gym tablet sign-out</a>
          <a href="#customize-stopped-coming" className="btn btn--ghost">Stopped coming</a>
          <a href="#customize-email-alerts" className="btn btn--ghost">Email alerts</a>
          <a href="#customize-record" className="btn btn--ghost">The record</a>
          <Link href="/admin/quotes" className="btn btn--ghost">Quotes</Link>
        </nav>
      </header>

      {/* --------------------------------------------- 0. THE GYM PROFILE -- */}
      {/* Lane L31 P3: the stored profile every page reads, edited here. */}
      <section className="mt-[var(--s6)] max-w-[1000px]" aria-labelledby="customize-profile">
        <h2 id="customize-profile" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          The gym&apos;s profile
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          The names, website, contact details and addresses the homepage, the privacy page, print sheets, the wall
          and the sign-in email use. Leave a line empty and the privacy page and print sheets leave it off; the
          homepage still has a place for every line.
        </p>
        <div className="mt-[var(--s4)]">
          <GymProfileForm />
        </div>
      </section>

      {/* ------------------------------------------------ 1. PHOTOGRAPHS -- */}
      <section className="mt-[var(--s6)] max-w-[1000px]" aria-labelledby="customize-photos">
        <h2 id="customize-photos" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          Photographs on the wall
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          Five of these frames appear on athlete and parent dashboards, where a photograph you upload
          replaces the drawn placeholder and taking it down puts the placeholder back. The front page
          shows only the drawings (entrance, floor, ring); an upload does not reach it yet. Pictures of the room,
          not of people — you are the release decision, so look at the photograph before you hang it.
        </p>

        <div className="mt-[var(--s4)] grid gap-[var(--s5)]">
          {GYM_PHOTO_SLOTS.map((slot) => {
            const hasUpload = uploaded.has(slot.key);
            const slotBusy = busy[slot.key] ?? 'idle';
            const notice = notices[slot.key];
            const version = versions[slot.key] ?? 0;
            const previewSrc = hasUpload
              ? `/api/pilot/gym-photos/${slot.key}${version > 0 ? `?v=${version}` : ''}`
              : gymPhotoSrc(slot.file);
            return (
              <article key={slot.key} className="mat-leather p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                  <div>
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{slot.title}</h3>
                    <p className="t-muted mt-[var(--s1)]">{gymPhotoSlotText(slot, gym).caption}</p>
                  </div>
                  {hasUpload ? (
                    <span className="badge badge--cleared"><span aria-hidden="true">✓</span> PHOTOGRAPH UP</span>
                  ) : (
                    <span className="t-label">PLACEHOLDER ILLUSTRATION</span>
                  )}
                </div>

                {previewSrc && (
                  <div className="mt-[var(--s4)] max-w-[610px] border border-[color:var(--hide-600)]">
                    {/* Same bare-<img> reasoning as PhotoSlot: the uploaded route
                        is session-scoped and must not pass through the optimizer's
                        shared cache. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={previewSrc} alt={gymPhotoSlotText(slot, gym).alt} loading="lazy" decoding="async" className="block w-full" />
                  </div>
                )}

                <div className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s3)]">
                  <label className="field">
                    <span className="t-label">JPEG or PNG, up to 8&nbsp;MB</span>
                    <input
                      ref={(element) => {
                        fileInputs.current[slot.key] = element;
                      }}
                      type="file"
                      accept="image/jpeg,image/png"
                      className="input"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn"
                    aria-busy={slotBusy === 'uploading'}
                    disabled={slotBusy !== 'idle'}
                    onClick={() => upload(slot.key)}
                  >
                    {slotBusy === 'uploading' ? 'Hanging it…' : hasUpload ? 'Replace the photograph' : 'Hang the photograph'}
                  </button>
                  {hasUpload && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      aria-busy={slotBusy === 'removing'}
                      disabled={slotBusy !== 'idle'}
                      onClick={() => remove(slot.key)}
                    >
                      Take it down
                    </button>
                  )}
                </div>

                {notice && (
                  <p role={notice.tone === 'error' ? 'alert' : 'status'} className="t-body mt-[var(--s3)]">
                    {notice.tone === 'error' ? (
                      <span className="badge badge--restricted"><span aria-hidden="true">▲</span> NOT HUNG</span>
                    ) : (
                      <span className="badge badge--cleared"><span aria-hidden="true">✓</span> DONE</span>
                    )}
                    <span className="ml-[var(--s2)]">{notice.text}</span>
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------- 2. THE BOARDS -- */}
      <section className="mt-[var(--s7)] max-w-[1000px]" aria-labelledby="customize-boards">
        <h2 id="customize-boards" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          The boards
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          One chalk line each, in your own words, changed whenever you feel like it. Writing on a board
          rubs out whatever was on it for everybody who sees it — there is no history on the wall, and
          that is the point. Board writes go through the staff sign-in; if writing is refused here, the
          board says why.
        </p>

        <div className="mt-[var(--s4)] flex flex-col gap-[var(--s6)]">
          {BOARDS.map((board) => (
            <section key={board.placement} aria-label={board.where}>
              <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{board.where}</p>
              <p className="mt-[var(--s2)] max-w-[62ch] text-[length:var(--t-xs)] leading-6 text-[color:var(--bone-400)]">
                {board.who}
              </p>
              <Chalkboard placement={board.placement} className="mt-[var(--s3)]" />
            </section>
          ))}
        </div>
      </section>

      {/* ------------------------------------------- 3. THE GYM TABLET -- */}
      {/* Lane U1, AS2-b: Jason's ruling OW25-53 A puts the tablet idle time
          in gym settings, set by the gym admin. */}
      <section className="mt-[var(--s7)] max-w-[1000px]" aria-labelledby="customize-tablet">
        <h2 id="customize-tablet" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          Gym tablet sign-out
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          A device marked as a gym tablet signs itself out after this long with no one using it, so a tablet
          left alone does not stay signed in as the last person. While the screen stays on, a one-minute
          countdown shows first and a tap keeps it signed in; a tablet that slept past the time signs out as it
          wakes. Phones and computers that are not marked are not signed out by this. A changed time reaches a
          tablet the next time a page loads there.
        </p>
        <div className="mt-[var(--s4)]">
          <GymTabletSettings />
        </div>
      </section>

      {/* ------------------------------------------- 4. STOPPED COMING -- */}
      {/* Lane W4-6, SC-0b: Jason's ruling OW27-30 A makes the number of days a
          gym setting the gym admin can change, first value 2 weeks. */}
      <section className="mt-[var(--s7)] max-w-[1000px]" aria-labelledby="customize-stopped-coming">
        <h2 id="customize-stopped-coming" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          Stopped coming
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          The Stopped Coming page lists athletes on the roster who have come before but have not come for this
          long or more, leaving out athletes marked as left the gym and athletes whose program memberships have
          all lapsed or ended. Coaches and the gym admin read that list. A change applies at once; a Stopped
          Coming page already open shows it the next time it reads the list.
        </p>
        <div className="mt-[var(--s4)]">
          <StoppedComingSettings />
        </div>
      </section>

      {/* --------------------------------------------- 5. EMAIL ALERTS -- */}
      {/* Lane W4-1, EM-6: Jason's ruling OW27-10 A has the gym's organization
          admin pick, per user type, which events may send the email; OW27-39 A,
          every event starts ticked and each person's own switch starts off. */}
      <section className="mt-[var(--s7)] max-w-[1000px]" aria-labelledby="customize-email-alerts">
        <h2 id="customize-email-alerts" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          Email alerts
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          Which events may send the email alert to each kind of person at this gym. Every event starts ticked; an
          unticked one emails nobody of that kind. A ticked one emails only people who can see it in the app and
          have switched email alerts on for themselves, on their own page, where everyone&apos;s switch starts off.
          The email says only &ldquo;open the app&rdquo;, with the gym&apos;s name in its subject: no link, and
          nothing about what happened or who it is about. A chalk line on the boards above, and a notice on the
          sign-in page, email nobody.
        </p>
        <div className="mt-[var(--s4)]">
          <EmailAlertSettings />
        </div>
      </section>

      {/* ------------------------------------------------- 6. THE RECORD -- */}
      <section className="mt-[var(--s7)] max-w-[1000px]" aria-labelledby="customize-record">
        <h2 id="customize-record" className="t-command" style={{ fontSize: 'var(--t-lg)' }}>
          The record
        </h2>
        <p className="t-muted mt-[var(--s2)] max-w-[68ch]">
          The boards above are the two-second version. History, schedule windows, and retiring live on
          their own pages, and the staff card photograph still ships the careful way — a committed file,
          so the person releasing a named coach&apos;s face is looking at the repository, not a form.
        </p>
        <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
          {/* NOT "the full record", which is what this label used to say.
              /notices reads NOTICE_READ_LIMIT (25) and announcements.ts
              clamps that read to 25 anyway, newest first, with no pager --
              so the destination holds the recent slice, not the record. The
              page's own heading was corrected to "Recently Posted"; a button
              promising the whole record to get there put the claim back. */}
          <Link href="/notices" className="btn btn--ghost">Notices — recently posted</Link>
          <Link href="/chalkboard" className="btn btn--ghost">The boards&apos; own desk</Link>
          <BackHome />
        </div>
      </section>
    </main>
  );
}
