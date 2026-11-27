'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import {
  EMAIL_ALERT_USER_TYPES,
  isEmailAlertEventFor,
  type EMAIL_ALERT_EVENTS,
  type EmailAlertUserType,
} from '@/src/shared/emailAlerts';

/**
 * Email alerts, on Customize the Gym (lane W4-1, EM-6; plan on #2159). Jason's
 * ruling OW27-10 A: the gym's organization admin picks, per user type, which
 * events may send the email; each person has one switch of their own (on
 * /profile, EmailAlertSwitch). OW27-39 A: every event starts ticked; each
 * person's switch still starts off. OD-2026-11-19-019: the email says only
 * "open the app" (and the gym's name in the subject, OW27-07 B).
 *
 * GET/PUT /api/pilot/email-alerts/gym (EM-5). The route admits the
 * organization admin and, by alias, 'admin' (roleAlias.ts), the same two roles
 * as the photo route that opens this desk. The PUT body is exactly
 * { user_type, event_kind, ticked }.
 *
 * A tick box shows only what the server said: it moves when a save comes back
 * confirmed, never on the press. A save that is not confirmed (no answer, a
 * 5xx, another 4xx, a 2xx that does not say the box sent) reads the choices
 * again and says "not saved" only if the box is not as asked. A 401 or 403, on
 * the read or a save, takes every box away. An unknown choice is never shown
 * as a box: when a save's outcome is not known and the read after it fails, an
 * alert replaces the boxes (StoppedComingSettings' rule), and focus goes to it
 * if nothing else has it.
 *
 * Every line says only what the code does: the event sources and who each one
 * reaches are src/server/pilot/emailAlertEvents.ts; the checks before every
 * send and the email itself are emailAlertSender.ts.
 */

const ROUTE = '/api/pilot/email-alerts/gym';

const SIGNED_OUT = 'You are signed out. Sign in again to see or change these choices.';
const ADMIN_ONLY = 'Only the gym admin can see or change these choices.';
const COULD_NOT_READ = 'The email alert choices could not be read. Reload to try again.';

interface Words {
  readonly label: string;
  readonly hint: string;
}

const WHO: Readonly<Record<EmailAlertUserType, { readonly heading: string; readonly inLine: string; readonly note?: string }>> = {
  staff: { heading: 'Coaches and admins', inLine: 'coaches and admins' },
  parent: { heading: 'Parents', inLine: 'parents' },
  adult_athlete: {
    heading: 'Athletes 18 or over',
    inLine: 'athletes 18 or over',
    note: 'Sent only to the address the athlete has confirmed. An athlete with no date of birth on record counts as under 18 and is sent nothing.',
  },
};

// One entry per event on each user type's list; `npm run typecheck` (tsc)
// refuses this object if an event is added to EMAIL_ALERT_EVENTS without words.
const EVENT_WORDS: { readonly [U in EmailAlertUserType]: Readonly<Record<(typeof EMAIL_ALERT_EVENTS)[U][number], Words>> } = {
  staff: {
    safety_escalation: { label: 'A new safety escalation', hint: 'SHADOW safety alerts and pain-note alerts included.' },
    parent_reply: { label: 'A guardian’s reply to a family note', hint: 'A reply under a note a coach or admin posted to the family.' },
    guardian_message: {
      label: 'A guardian’s new message to the coach',
      hint: 'Only to the child’s coach, a coach covering the child now and the gym’s admins, and not once they have seen it.',
    },
    gym_notice: { label: 'A notice going live', hint: 'On the Coach Workspace, Athlete Workspace, Parent Hub or Everywhere.' },
  },
  parent: {
    family_note: { label: 'A coach’s or admin’s note to the family', hint: 'To each guardian linked to the child, while the child is under 18.' },
    gym_notice: { label: 'A notice going live', hint: 'On the Parent Hub or Everywhere.' },
  },
  adult_athlete: {
    coach_message: { label: 'A coach’s or admin’s message to the athlete', hint: 'Only to the athlete it is written to.' },
    gym_notice: { label: 'A notice going live', hint: 'On the Athlete Workspace or Everywhere.' },
  },
};

interface Choice {
  readonly userType: EmailAlertUserType;
  readonly eventKind: string;
  readonly ticked: boolean;
}

type View =
  | { readonly state: 'loading' }
  /** No boxes: a refusal, a failed read, or an unknown outcome. */
  | { readonly state: 'stopped'; readonly words: string }
  | { readonly state: 'loaded'; readonly choices: readonly Choice[] };

type Read = { readonly choices: readonly Choice[] } | 'signed_out' | 'refused' | 'failed';

function wordsFor(choice: Choice): Words {
  return (EVENT_WORDS[choice.userType] as Readonly<Record<string, Words>>)[choice.eventKind];
}

const sameBox = (a: Choice, b: Choice) => a.userType === b.userType && a.eventKind === b.eventKind;

/** One event as the route answers it ({ user_type, event_kind, ticked, is_default }), on the list, or null. */
function readChoice(value: unknown): Choice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { user_type: userType, event_kind: eventKind, ticked, is_default: isDefault } = value as Record<string, unknown>;
  if (!isEmailAlertEventFor(userType, eventKind) || typeof ticked !== 'boolean' || typeof isDefault !== 'boolean') return null;
  return { userType: userType as EmailAlertUserType, eventKind: eventKind as string, ticked };
}

/** The GET with its shape check: { ok: true, events: [...] }, every event on the list, none twice. */
async function readChoices(): Promise<Read> {
  try {
    const response = await fetch(`${apiBase()}${ROUTE}`, { credentials: 'include', cache: 'no-store' });
    if (response.status === 401) return 'signed_out';
    if (response.status === 403) return 'refused';
    if (!response.ok) return 'failed';
    const body = (await response.json()) as { ok?: unknown; events?: unknown } | null;
    if (body?.ok !== true || !Array.isArray(body.events) || body.events.length === 0) return 'failed';
    const choices = body.events.map(readChoice);
    if (choices.some((choice) => choice === null)) return 'failed';
    const read = choices as Choice[];
    if (new Set(read.map((choice) => `${choice.userType}:${choice.eventKind}`)).size !== read.length) return 'failed';
    return { choices: read };
  } catch {
    return 'failed';
  }
}

export default function EmailAlertSettings() {
  const [view, setView] = useState<View>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState('');
  const [notSaved, setNotSaved] = useState('');
  // Set before the first await, so a second press before React re-renders sends nothing.
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void readChoices().then((read) => {
      if (cancelled) return;
      if (read === 'signed_out') setView({ state: 'stopped', words: SIGNED_OUT });
      else if (read === 'refused') setView({ state: 'stopped', words: ADMIN_ONLY });
      else if (read === 'failed') setView({ state: 'stopped', words: COULD_NOT_READ });
      else setView({ state: 'loaded', choices: read.choices });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A press whose boxes were taken away leaves focus on the body: it goes to the alert then.
  useEffect(() => {
    if (settled === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    alertRef.current?.focus();
  }, [settled]);

  const press = async (box: Choice) => {
    if (view.state !== 'loaded' || inFlight.current) return;
    inFlight.current = true;
    const asked = !box.ticked;
    const label = wordsFor(box).label;
    const who = WHO[box.userType].inLine;
    setSaving(true);
    setLine('Saving…');
    setNotSaved('');
    try {
      const response = await fetch(`${apiBase()}${ROUTE}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_type: box.userType, event_kind: box.eventKind, ticked: asked }),
      }).catch(() => null);
      // Refused before anything is written (route.ts: requirePrincipal, then requireRole).
      if (response?.status === 401) {
        setView({ state: 'stopped', words: `Not saved. ${SIGNED_OUT}` });
        return;
      }
      if (response?.status === 403) {
        setView({ state: 'stopped', words: `Not saved. ${ADMIN_ONLY}` });
        return;
      }
      const answer = response?.ok ? ((await response.json().catch(() => null)) as { ok?: unknown; event?: unknown } | null) : null;
      const saved = answer?.ok === true ? readChoice(answer.event) : null;
      if (saved && sameBox(saved, box) && saved.ticked === asked) {
        setView({ state: 'loaded', choices: view.choices.map((choice) => (sameBox(choice, saved) ? saved : choice)) });
        setLine(`Saved: “${label}” is now ${asked ? 'ticked' : 'unticked'} for ${who}.`);
        return;
      }
      // Not known: show what the server holds now, not what was asked for.
      const read = await readChoices();
      if (read === 'signed_out' || read === 'refused' || read === 'failed') {
        const why = read === 'signed_out' ? 'you are signed out. Sign in again to see these choices.'
          : read === 'refused' ? 'only the gym admin can see these choices.'
            : 'the choices could not be read again. Reload to see them.';
        setView({ state: 'stopped', words: `It is not known whether that change was saved, and ${why}` });
        return;
      }
      setView({ state: 'loaded', choices: read.choices });
      const now = read.choices.find((choice) => sameBox(choice, box));
      if (!now) {
        setLine('It is not known whether that change was saved. The choices shown have been read again.');
      } else if (now.ticked === asked) {
        setLine(`“${label}” is now ${asked ? 'ticked' : 'unticked'} for ${who}. The choices shown have been read again.`);
      } else {
        setLine('');
        setNotSaved(`That change was not saved: “${label}” is still ${now.ticked ? 'ticked' : 'unticked'} for ${who}.`);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
      setSettled((count) => count + 1);
    }
  };

  if (view.state === 'loading') return <p className="t-muted">Reading the email alert choices…</p>;
  if (view.state === 'stopped') {
    return (
      <p ref={alertRef} tabIndex={-1} role="alert" className="t-body">
        <span aria-hidden="true">▲ </span>
        {view.words}
      </p>
    );
  }

  return (
    <div aria-busy={saving}>
      {EMAIL_ALERT_USER_TYPES.map((userType) => {
        const boxes = view.choices.filter((choice) => choice.userType === userType);
        if (boxes.length === 0) return null;
        const who = WHO[userType];
        return (
          <fieldset key={userType} className="mt-[var(--s4)] first:mt-0">
            <legend className="t-label">{who.heading}</legend>
            {who.note ? <p className="t-muted mt-[var(--s1)] max-w-[68ch]">{who.note}</p> : null}
            <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
              {boxes.map((box) => {
                const id = `email-alert-${box.userType}-${box.eventKind}`;
                const words = wordsFor(box);
                return (
                  <li key={id}>
                    <label className="inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s2)]">
                      {/* aria-disabled, not disabled, so focus stays on the box pressed; the handler does nothing then. */}
                      <input
                        type="checkbox"
                        className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                        checked={box.ticked}
                        aria-disabled={saving}
                        aria-describedby={`${id}-hint`}
                        onChange={() => {
                          if (!saving) void press(box);
                        }}
                      />
                      <span className="t-body">{words.label}</span>
                    </label>
                    <p id={`${id}-hint`} className="t-muted">{words.hint}</p>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
      <p role="status" className="t-body mt-[var(--s3)]">{line}</p>
      {notSaved ? (
        <p role="alert" className="t-body mt-[var(--s2)]">
          <span aria-hidden="true">▲ </span>
          {notSaved}
        </p>
      ) : null}
    </div>
  );
}
