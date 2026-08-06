'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { GYM_PHOTO_SLOTS, gymPhotoSrc } from '@/src/shared/gymPhotos';

/**
 * THE GYM WALL, FROM THE OFFICE SIDE -- hang and take down building
 * photographs without a git client.
 *
 * Each slot below is one frame from src/shared/gymPhotos.ts. Today every frame
 * holds a commissioned placeholder ILLUSTRATION; a photograph uploaded here is
 * stored org-scoped in private blob storage (EXIF/GPS stripped server-side)
 * and takes the frame over the illustration everywhere the slot appears --
 * dashboards and the public page alike. Removing it puts the illustration
 * back. The release rule is a person who can see the picture deciding it goes
 * up; this page is that person's desk.
 */

type SlotBusy = 'idle' | 'uploading' | 'removing';

interface SlotNotice {
  readonly tone: 'ok' | 'error';
  readonly text: string;
}

export default function AdminGymPhotosPage() {
  const [access, setAccess] = useState<'checking' | 'allowed' | 'denied'>('checking');
  const [uploaded, setUploaded] = useState<ReadonlySet<string>>(new Set());
  // Bumped per slot on upload so the <img> re-fetches past the browser cache.
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<Record<string, SlotBusy>>({});
  const [notices, setNotices] = useState<Record<string, SlotNotice>>({});
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/pilot/admin/gym-photos');
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
  }, []);

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
      const response = await fetch('/api/pilot/admin/gym-photos', { method: 'POST', body });
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
      const response = await fetch(`/api/pilot/admin/gym-photos?slot=${encodeURIComponent(slotKey)}`, {
        method: 'DELETE',
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

  if (access === 'checking') {
    return (
      <main className="room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
        <p className="working">Opening the photo drawer</p>
      </main>
    );
  }

  if (access === 'denied') {
    return (
      <main className="room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
        <div className="mat-leather max-w-[610px] p-[var(--s5)]">
          <p className="t-eyebrow">Gym wall</p>
          <p className="t-body mt-[var(--s3)]">
            <span className="badge badge--locked"><span aria-hidden="true">✕</span> ADMINS ONLY</span>
          </p>
          <p className="t-muted mt-[var(--s3)]">
            Hanging photographs on the gym wall is an administrator&apos;s decision. Ask your organization admin.
          </p>
          <Link href="/admin" className="btn btn--ghost mt-[var(--s4)]">Back to the office</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="room--office min-h-screen px-[var(--s5)] py-[var(--s6)]">
      <header className="mat-leather max-w-[1000px] p-[var(--s5)]">
        <p className="t-eyebrow">Gym wall</p>
        <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
          Photographs of the building
        </h1>
        <p className="t-body mt-[var(--s3)] max-w-[68ch]">
          Each frame below appears on dashboards and the public page. Today it holds a drawn placeholder;
          a photograph you upload here takes the frame, and taking it down puts the placeholder back.
          Pictures of the room, not of people — you are the release decision, so look at the photograph
          before you hang it.
        </p>
      </header>

      <section className="mt-[var(--s5)] grid max-w-[1000px] gap-[var(--s5)]" aria-label="Wall slots">
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
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{slot.title}</h2>
                  <p className="t-muted mt-[var(--s1)]">{slot.caption}</p>
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
                  <img src={previewSrc} alt={slot.alt} loading="lazy" decoding="async" className="block w-full" />
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
                    <span className="badge badge--locked"><span aria-hidden="true">✕</span> NOT HUNG</span>
                  ) : (
                    <span className="badge badge--cleared"><span aria-hidden="true">✓</span> DONE</span>
                  )}
                  <span className="ml-[var(--s2)]">{notice.text}</span>
                </p>
              )}
            </article>
          );
        })}
      </section>

      <div className="mt-[var(--s5)]">
        <Link href="/admin" className="btn btn--ghost">Back to the office</Link>
      </div>
    </main>
  );
}
