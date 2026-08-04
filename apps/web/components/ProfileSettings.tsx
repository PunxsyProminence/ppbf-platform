'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import FightCard from './FightCard';
import {
  CORNER_OPTIONS,
  downscalePhoto,
  NICKNAME_MAX_LENGTH,
  PROGRAM_OPTIONS,
  type CornerChoice,
  type FightCardPayload,
  type ProfileSettingsPayload,
  type ProgramChoice,
} from './profileClient';
import { apiBase } from '@/lib/apiBase';

/**
 * YOUR CORNER — the one screen in the platform that is about you rather than
 * about your training.
 *
 * Everything here is scoped to the signed-in member. There is no account
 * selector and there must not be one: reading or writing somebody else's
 * identity goes through routes that run the visibility gate, and a form that
 * can be pointed at an account id is a form that will eventually be pointed at
 * the wrong one.
 *
 * The card at the top is the actual FightCard component, not a preview of it,
 * so what a member is editing is the thing itself.
 */

type Saving = 'idle' | 'saving' | 'saved' | 'failed';

const PANEL = 'mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]';
const HEADING = 't-eyebrow';
const HELP = 'text-[length:var(--t-xs)] text-[color:var(--bone-400)] leading-[1.5]';
const CHOICE_BASE =
  'inline-flex min-h-[var(--tap)] items-center gap-[var(--s3)] rounded-[var(--r-sm)] border-2 px-[var(--s4)] '
  + 'font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.1em] transition '
  + 'focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const CHOICE_ON = 'border-[color:var(--brass-500)] bg-[rgba(212,175,74,.14)] text-[color:var(--bone-100)]';
const CHOICE_OFF =
  'border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-500)]';

export default function ProfileSettings() {
  const [settings, setSettings] = useState<ProfileSettingsPayload | null>(null);
  const [card, setCard] = useState<FightCardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Saving>('idle');
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const response = await fetch(`${apiBase()}/api/pilot/profile/me`, { credentials: 'include' });
      if (!response.ok) throw new Error('Could not load your card.');
      const payload = (await response.json()) as {
        settings?: ProfileSettingsPayload;
        card?: FightCardPayload | null;
      };
      if (payload.settings) {
        setSettings(payload.settings);
        setNicknameDraft(payload.settings.nickname ?? '');
      }
      setCard(payload.card ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load your card.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setSaving('saving');
    setNicknameError(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/profile/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        setSaving('failed');
        if ('nickname' in body) setNicknameError(payload.error ?? 'That could not be saved.');
        return false;
      }
      setSaving('saved');
      await load();
      return true;
    } catch {
      setSaving('failed');
      return false;
    }
  }, [load]);

  const uploadPhoto = useCallback(async (file: File) => {
    setPhotoError(null);
    setPhotoNotice(null);
    // Downscaled here as a courtesy so a phone photo is not a 413. The server
    // measures the real dimensions itself and is the only authority on them.
    const prepared = await downscalePhoto(file);
    const form = new FormData();
    form.append('photo', prepared);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/profile/photo`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!response.ok || !payload.ok) {
        setPhotoError(payload.error ?? 'That photo could not be accepted.');
        return;
      }
      setPhotoNotice(payload.message ?? 'Uploaded.');
      await load();
    } catch {
      setPhotoError('That photo could not be uploaded.');
    }
  }, [load]);

  const removePhoto = useCallback(async () => {
    setPhotoError(null);
    setPhotoNotice(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/profile/photo`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) {
        setPhotoError('That photo could not be removed.');
        return;
      }
      setPhotoNotice('Removed.');
      await load();
    } catch {
      setPhotoError('That photo could not be removed.');
    }
  }, [load]);

  if (loadError) {
    return (
      <div className={PANEL}>
        <p className="text-[color:var(--locked-ink)] text-[length:var(--t-sm)]">{loadError}</p>
        <button type="button" className="btn btn--ghost" onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className={PANEL}>
        <p className="t-muted">Loading your card…</p>
      </div>
    );
  }

  const reviewNotice =
    settings.photo_review_state === 'pending_review' && settings.has_photo
      ? 'Only you can see this until a coach or an administrator releases it.'
      : settings.photo_review_state === 'blocked'
        ? 'This photo was taken down by the gym. Talk to your coach.'
        : null;

  return (
    <div className="space-y-[var(--s5)] corner-scope" data-corner={settings.corner}>
      {/* The rope is the corner post's tape. It is the first thing on the
          member's own screen, and it is the only place on this page the corner
          appears as a large area of colour. */}
      <div className="corner-rope" aria-hidden="true" />

      {card && <FightCard card={card} />}

      {/* ------------------------------------------------------ PORTRAIT -- */}
      <section className={PANEL} aria-labelledby="portrait-heading">
        <h2 id="portrait-heading" className={HEADING}>Your portrait</h2>
        <p className={HELP}>
          JPEG or PNG, stored at 512 pixels. Location and camera data are stripped from the
          file before it is saved — the gym never keeps where a photo was taken.
        </p>
        <div className="flex flex-wrap items-center gap-[var(--s4)]">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadPhoto(file);
              event.target.value = '';
            }}
          />
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
            {settings.has_photo ? 'Replace photo' : 'Add a photo'}
          </button>
          {settings.has_photo && (
            <button type="button" className="btn btn--ghost" onClick={() => void removePhoto()}>
              Remove photo
            </button>
          )}
        </div>
        {reviewNotice && <p className={HELP}>{reviewNotice}</p>}
        {photoNotice && <p className="text-[length:var(--t-xs)] text-[color:var(--cleared-ink)]">{photoNotice}</p>}
        {photoError && <p className="text-[length:var(--t-xs)] text-[color:var(--locked-ink)]">{photoError}</p>}
        <p className={HELP}>
          With no photo your card shows a brass plate with your initials. That is a finished
          object, not a placeholder — nothing on your card looks unfinished without one.
        </p>
      </section>

      {/* ----------------------------------------------------- RING NAME -- */}
      <section className={PANEL} aria-labelledby="ring-heading">
        <h2 id="ring-heading" className={HEADING}>Your ring name</h2>
        <p className={HELP}>
          What the gym calls you. Your coaches and your guardians can see it. It never appears
          on a public page or in front of another family. Your coach or an administrator can
          clear it, and if they do you will need to talk to them before setting a new one.
        </p>
        <label className="field">
          <span className="sr-only">Ring name</span>
          <input
            className="input input--kiosk"
            value={nicknameDraft}
            maxLength={NICKNAME_MAX_LENGTH}
            placeholder="Sugar, The Groundhog, Lefty…"
            disabled={settings.nickname_locked}
            onChange={(event) => setNicknameDraft(event.target.value)}
          />
        </label>
        <p className={HELP}>
          {[...nicknameDraft].length}/{NICKNAME_MAX_LENGTH} characters. Letters, numbers, spaces,
          apostrophes and hyphens.
        </p>
        {settings.nickname_locked && (
          <p className="text-[length:var(--t-xs)] text-[color:var(--restricted-ink)]">
            Your ring name was cleared by the gym. Talk to your coach before setting a new one.
          </p>
        )}
        {nicknameError && (
          <p className="text-[length:var(--t-xs)] text-[color:var(--locked-ink)]">{nicknameError}</p>
        )}
        <div className="flex flex-wrap gap-[var(--s4)]">
          <button
            type="button"
            className="btn"
            disabled={settings.nickname_locked}
            onClick={() => void patch({ nickname: nicknameDraft })}
          >
            Save ring name
          </button>
          {settings.nickname && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => { setNicknameDraft(''); void patch({ nickname: null }); }}
            >
              Clear it
            </button>
          )}
        </div>
      </section>

      {/* -------------------------------------------------------- CORNER -- */}
      <section className={PANEL} aria-labelledby="corner-heading">
        <h2 id="corner-heading" className={HEADING}>Your corner</h2>
        <p className={HELP}>
          Red or blue. It tints your own card, your own plate and your own header — nobody
          else&rsquo;s screen changes. The dyes are kept deliberately quieter than the gym&rsquo;s
          safety colours, so a corner can never be mistaken for a clearance state.
        </p>
        <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Corner">
          {CORNER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={settings.corner === option.value}
              className={`${CHOICE_BASE} ${settings.corner === option.value ? CHOICE_ON : CHOICE_OFF}`}
              onClick={() => void patch({ corner: option.value satisfies CornerChoice })}
            >
              <span
                aria-hidden="true"
                className="h-[13px] w-[13px] flex-none rounded-[2px] corner-scope"
                data-corner={option.value}
                style={{ backgroundColor: 'var(--corner-edge)' }}
              />
              {option.label}
            </button>
          ))}
        </div>
        <p className={HELP}>{CORNER_OPTIONS.find((o) => o.value === settings.corner)?.hint}</p>
      </section>

      {/* ----------------------------------------------------- PROGRAMME -- */}
      <section className={PANEL} aria-labelledby="programme-heading">
        <h2 id="programme-heading" className={HEADING}>Your programme</h2>
        <p className={HELP}>
          What you come here for. Every programme reads the same on a card — this gym runs
          fitness, adult recreational, youth mentorship and competitive, and none of them is a
          lesser version of another.
        </p>
        <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Programme">
          {PROGRAM_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={settings.program === option.value}
              className={`${CHOICE_BASE} ${settings.program === option.value ? CHOICE_ON : CHOICE_OFF}`}
              onClick={() => void patch({ program: option.value satisfies ProgramChoice })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <p className="t-muted text-[length:var(--t-xs)]" aria-live="polite">
        {saving === 'saving' && 'Saving…'}
        {saving === 'saved' && 'Saved.'}
        {saving === 'failed' && 'That change was not saved.'}
      </p>
    </div>
  );
}
