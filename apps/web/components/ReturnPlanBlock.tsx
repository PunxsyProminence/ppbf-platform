'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// The "Return plan" block under one injury on /coach/injuries (lane P8 PR 2):
// the plan's steps in week order with the current step marked, Advance (with
// the coach's note) and Add step.
//
// THE COACH'S DECISION, RECORDED AND SHOWN. Nothing here advises, scores,
// diagnoses or proposes a step: no week is prefilled, no contact level is
// preselected, and the only step marked is the one the route calls current
// (the earliest not yet advanced). Not a medical clearance and it lifts no
// training hold (route header, OD-2026-09-21-001).
//
// Authorization and every rule are the route's
// (/api/pilot/coach/return-to-training): this block sends what the coach
// entered and shows the route's own answer. A reply that could not be read is
// never shown as an empty plan.
//
// data-surface="kiosk" on the root: Law 5, the repo's one-attribute device --
// controls take the 55px floor and the voices the 19.1px floor.

/** The route's contact values, lowest first. Pinned to route.ts by ReturnPlanBlock.test.tsx. */
export const RTT_CONTACT = ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'] as const;
/** The route's scale levels. Pinned to route.ts by ReturnPlanBlock.test.tsx. */
export const RTT_SCALE = ['A', 'B', 'C'] as const;

interface Step {
  step_id: string;
  week_number: number;
  intensity_label: string;
  permitted_contact: string;
  permitted_scale_level: string | null;
  planned_note: string;
  advanced_at: string | null;
  advancement_note: string | null;
}

interface Plan {
  plan_id: string;
  status: string;
  steps: Step[];
  current_step_id: string | null;
}

type Reading =
  | { state: 'loading' }
  | { state: 'refused'; text: string }
  | { state: 'failed' }
  | { state: 'missing' }
  | { state: 'loaded'; plan: Plan };

const EMPTY_STEP = { week: '', intensity: '', contact: '', scale: '', plannedNote: '' };

function isStep(value: unknown): value is Step {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.step_id === 'string'
    && typeof s.week_number === 'number'
    && typeof s.intensity_label === 'string'
    && typeof s.permitted_contact === 'string'
    && (s.permitted_scale_level === null || typeof s.permitted_scale_level === 'string')
    && typeof s.planned_note === 'string'
    && (s.advanced_at === null || typeof s.advanced_at === 'string')
    && (s.advancement_note === null || typeof s.advancement_note === 'string');
}

function isPlan(value: unknown): value is Plan {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.plan_id === 'string'
    && typeof p.status === 'string'
    && Array.isArray(p.steps) && p.steps.every(isStep)
    && (p.current_step_id === null || typeof p.current_step_id === 'string');
}

function errorText(payload: unknown): string | null {
  const error = (payload as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error ? error : null;
}

export default function ReturnPlanBlock({ athleteId, planId }: { athleteId: string; planId: string | null }) {
  // What was read, with the athlete and plan it was read for: a reading for any
  // other athlete or plan is never shown, it reads as loading.
  const key = `${athleteId}|${planId ?? ''}`;
  const [stored, setStored] = useState<{ key: string; reading: Reading }>({ key, reading: { state: 'loading' } });
  const reading: Reading = stored.key === key ? stored.reading : { state: 'loading' };
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [step, setStep] = useState(EMPTY_STEP);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const id = useId();
  // Each read gets a number; only the newest read of a mounted block may land,
  // so one plan's steps never show under another injury or another athlete.
  const latest = useRef(0);

  // The steps already on screen stay there while a read is in flight.
  const read = useCallback(async () => {
    if (!planId) return;
    const ticket = latest.current + 1;
    latest.current = ticket;
    const land = (next: Reading) => { if (latest.current === ticket) setStored({ key, reading: next }); };
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/return-to-training?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as { ok?: unknown; plans?: unknown } | null;
      if (!response.ok) {
        const text = response.status < 500 ? errorText(payload) : null;
        land(text ? { state: 'refused', text } : { state: 'failed' });
        return;
      }
      if (!payload || payload.ok !== true || !Array.isArray(payload.plans)) throw new Error('unreadable');
      const plan = payload.plans.find((p) => (p as { plan_id?: unknown } | null)?.plan_id === planId);
      if (plan !== undefined && !isPlan(plan)) throw new Error('unreadable');
      land(plan ? { state: 'loaded', plan } : { state: 'missing' });
    } catch {
      land({ state: 'failed' });
    }
  }, [athleteId, planId, key]);

  useEffect(() => {
    void read();
    return () => { latest.current += 1; };
  }, [read]);

  const retry = () => {
    setStored({ key, reading: { state: 'loading' } });
    void read();
  };

  /** Send one write and show the route's answer. True when the route said it was saved. */
  const send = async (method: 'POST' | 'PATCH', body: Record<string, unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    let saved = false;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/return-to-training`, {
        method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: unknown } | null;
      if (!response.ok) {
        setNotice({ text: errorText(payload) ?? `That was not saved (${response.status}).`, error: true });
      } else if (payload?.ok !== true) {
        throw new Error('unreadable');
      } else {
        saved = true;
        setNotice({ text: done, error: false });
      }
    } catch {
      setNotice({
        text: 'No readable answer came back, so it is not known whether that was saved. Check the steps here before trying again.',
        error: true,
      });
    }
    // Saved, refused or unknown: the steps are read again, because a refusal
    // usually means this screen was behind what is recorded.
    await read();
    setBusy(false);
    return saved;
  };

  const advance = async (event: FormEvent, current: Step) => {
    event.preventDefault();
    if (!planId || busy) return;
    if (!note.trim()) {
      setNotice({ text: 'Write your note first: a step is advanced with the coach’s note.', error: true });
      return;
    }
    const saved = await send(
      'PATCH',
      { athlete_id: athleteId, plan_id: planId, step_id: current.step_id, advancement_note: note },
      `Week ${current.week_number} advanced.`,
    );
    if (saved) setNote('');
  };

  const addStep = async (event: FormEvent) => {
    event.preventDefault();
    if (!planId || busy) return;
    // The route saves a missing contact as "none"; nobody would have chosen that.
    if (!step.contact) {
      setNotice({ text: 'Choose the contact for this week.', error: true });
      return;
    }
    const week = step.week.trim();
    const saved = await send(
      'POST',
      {
        action: 'add_step', athlete_id: athleteId, plan_id: planId,
        // Anything that is not a whole number goes as typed, so the route words the refusal.
        week_number: /^\d+$/.test(week) ? Number(week) : week,
        intensity_label: step.intensity, permitted_contact: step.contact,
        permitted_scale_level: step.scale || null, planned_note: step.plannedNote,
      },
      'Step added.',
    );
    if (saved) {
      setStep(EMPTY_STEP);
      setAdding(false);
    }
  };

  const field = (key: keyof typeof EMPTY_STEP) => ({
    id: `${id}-${key}`,
    value: step[key],
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setStep((s) => ({ ...s, [key]: e.target.value })),
  });

  const plan = reading.state === 'loaded' ? reading.plan : null;
  const active = plan?.status === 'active';

  return (
    <section aria-label="Return plan" data-surface="kiosk"
      className="mt-[var(--s3)] rounded-[var(--r-md)] border border-[var(--hide-700)] p-[var(--s3)] text-[length:var(--t-md)]">
      <h3 className="t-label">Return plan</h3>

      {notice?.error && (
        <p role="alert" className="mt-[var(--s2)] font-semibold text-[var(--restricted-ink)]">
          <span aria-hidden="true">▲ </span>{notice.text}
        </p>
      )}
      {notice && !notice.error && (
        <p role="status" className="mt-[var(--s2)] font-semibold"><span aria-hidden="true">✓ </span>{notice.text}</p>
      )}

      {!planId && <p className="t-body mt-[var(--s2)]">No return plan on this injury.</p>}
      {planId && reading.state === 'loading' && <p className="t-body mt-[var(--s2)]">Loading return plan…</p>}
      {planId && reading.state === 'refused' && (
        <p role="alert" className="mt-[var(--s2)] font-semibold text-[var(--restricted-ink)]">
          <span aria-hidden="true">▲ </span>Not shown: {reading.text}
        </p>
      )}
      {planId && (reading.state === 'failed' || reading.state === 'missing') && (
        <div role="alert" className="mt-[var(--s2)]">
          <p className="font-semibold text-[var(--restricted-ink)]">
            <span aria-hidden="true">▲ </span>
            {reading.state === 'failed'
              ? 'The return plan could not be loaded.'
              : 'This injury is linked to a return plan that was not in the list the server sent.'}
          </p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={retry}>Try again</button>
        </div>
      )}

      {plan && (
        <>
          {!active && <p className="t-body mt-[var(--s2)]">This plan is {plan.status}. Its steps are shown as recorded.</p>}
          {plan.steps.length === 0 ? (
            <p className="t-body mt-[var(--s2)]">No steps on this plan yet.</p>
          ) : (
            <ol className="mt-[var(--s2)] grid gap-[var(--s3)]">
              {plan.steps.map((s) => {
                const current = s.step_id === plan.current_step_id;
                return (
                  <li key={s.step_id} aria-current={current ? 'step' : undefined} className="border-t border-[var(--hide-700)] pt-[var(--s2)]">
                    <p className="t-body font-semibold">
                      Week {s.week_number} · {s.intensity_label}{current ? ' · ▸ Current step' : ''}
                    </p>
                    <p className="t-body">
                      Contact: {humanizeContactLevel(s.permitted_contact)}
                      {s.permitted_scale_level ? ` · Scale ${s.permitted_scale_level}` : ''}
                    </p>
                    {s.planned_note && <p className="t-body">Plan note: {s.planned_note}</p>}
                    {s.advanced_at && (
                      <p className="t-body">
                        Advanced {formatGymDateNumeric(s.advanced_at) ?? s.advanced_at.slice(0, 10)}
                        {s.advancement_note ? ` · Coach’s note: ${s.advancement_note}` : ''}
                      </p>
                    )}
                    {current && active && (
                      <form aria-label={`Advance week ${s.week_number}`} className="mt-[var(--s2)]" onSubmit={(e) => void advance(e, s)}>
                        <div className="field">
                          <label className="t-label" htmlFor={`${id}-note`}>Your note on this decision (required)</label>
                          <textarea id={`${id}-note`} className="textarea min-h-[var(--tap)]" rows={2} maxLength={2000} required
                            value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
                        </div>
                        <button type="submit" className="btn mt-[var(--s2)]" disabled={busy}>Advance</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {plan.steps.length > 0 && plan.current_step_id === null && (
            <p className="t-body mt-[var(--s2)]">Every step of this plan has been advanced.</p>
          )}

          {active && (
            <div className="mt-[var(--s3)]">
              <button type="button" className="btn btn--ghost" aria-expanded={adding} aria-controls={`${id}-add`} disabled={busy}
                onClick={() => { setAdding((open) => !open); setNotice(null); }}>
                Add step
              </button>
              {adding && (
                <form id={`${id}-add`} aria-label="Add a step" className="mt-[var(--s3)]" onSubmit={(e) => void addStep(e)}>
                  <div className="grid gap-[var(--s3)] sm:grid-cols-2">
                    <div className="field"><label className="t-label" htmlFor={`${id}-week`}>Week number</label>
                      <input type="number" className="input" min={1} max={520} step={1} required {...field('week')} /></div>
                    <div className="field"><label className="t-label" htmlFor={`${id}-contact`}>Contact</label>
                      <select className="select" required {...field('contact')}>
                        <option value="">Choose</option>
                        {RTT_CONTACT.map((c) => <option key={c} value={c}>{humanizeContactLevel(c)}</option>)}
                      </select></div>
                    <div className="field"><label className="t-label" htmlFor={`${id}-intensity`}>This week&apos;s ceiling, in your words</label>
                      <input type="text" className="input" maxLength={2000} required {...field('intensity')} /></div>
                    <div className="field"><label className="t-label" htmlFor={`${id}-scale`}>Scale (optional)</label>
                      <select className="select" {...field('scale')}>
                        <option value="">Not set</option>
                        {RTT_SCALE.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select></div>
                  </div>
                  <div className="field mt-[var(--s3)]"><label className="t-label" htmlFor={`${id}-plannedNote`}>Plan note (optional)</label>
                    <textarea className="textarea min-h-[var(--tap)]" rows={2} maxLength={2000} {...field('plannedNote')} /></div>
                  <button type="submit" className="btn mt-[var(--s3)]" disabled={busy}>Save step</button>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
