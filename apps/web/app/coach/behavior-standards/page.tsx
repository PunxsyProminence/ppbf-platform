'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Behavior standards (module 125). Two paths, and the page keeps them
// visibly apart because that separation is the whole design:
//
//   MET a standard  -> a recognition, in the athlete's own record, in the
//                      gym's own words.
//   A CONCERN       -> the safeguarding queue, where an org admin sees it
//                      and it is acknowledged and resolved. It is never
//                      written into a behavior log, because no such log
//                      exists.
//
// The page says that out loud rather than leaving a coach to guess where a
// concern goes.

interface StandardRow {
  standard_id: string;
  standard_name: string;
  description: string;
  recognition_kind: string;
  active: boolean;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;

export default function BehaviorStandardsPage() {
  const [standards, setStandards] = useState<StandardRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [recognizeForm, setRecognizeForm] = useState({ standard_id: '', athlete_id: '', note: '' });
  const [concernForm, setConcernForm] = useState({ athlete_id: '', reason: '', severity: 'moderate' });

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/behavior-standards`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load standards.');
    const payload = (await response.json()) as { items?: StandardRow[] };
    setStandards(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [, athleteResponse] = await Promise.all([
          reload(controller.signal),
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (athleteResponse.ok) {
          const payload = (await athleteResponse.json()) as { items?: AthleteOption[] };
          if (!controller.signal.aborted) setAthletes(payload.items ?? []);
        }
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load standards.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const send = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/behavior-standards`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `${failure} (${response.status})`);
      }
      setErrorMessage(null);
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : failure);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleRecognize = async () => {
    if (!recognizeForm.standard_id || !recognizeForm.athlete_id) {
      setErrorMessage('Pick a standard and an athlete.');
      return;
    }
    const result = await send({ action: 'recognize', ...recognizeForm }, 'Unable to record the recognition.');
    if (!result) return;
    setRecognizeForm({ standard_id: '', athlete_id: '', note: '' });
    setNotice('Recognition recorded — it is in that athlete’s own record, in your name.');
  };

  const handleConcern = async () => {
    if (!concernForm.athlete_id || !concernForm.reason.trim()) {
      setErrorMessage('A concern needs an athlete and a reason in your own words.');
      return;
    }
    const result = await send({ action: 'raise_concern', ...concernForm }, 'Unable to raise the concern.');
    if (!result) return;
    setConcernForm({ athlete_id: '', reason: '', severity: 'moderate' });
    setNotice('Concern filed to the safeguarding queue. An org admin sees it and it stays open until resolved.');
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Standards</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              What this gym expects, and the two things you can do about it. Meeting a standard
              becomes a recognition in the athlete&rsquo;s own record. A concern goes to the
              safeguarding queue to be handled — there is no behaviour log here, and nothing about
              a young person gets written down that nobody is going to act on.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {notice && (
            <div className="alert alert--ready" role="status">
              <span className="alert-icon" aria-hidden="true">✓</span>
              <div className="alert-body">
                <p className="alert-title">Recorded</p>
                <p className="alert-msg">{notice}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s6)]">
              <span className="working">Loading standards...</span>
            </div>
          ) : standards.length === 0 ? (
            <p className="t-body">
              No standards posted yet. An admin posts them, and each one names the recognition that
              evidences it.
            </p>
          ) : (
            <>
              <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s3)]">Posted standards</h2>
                <ul className="space-y-[var(--s2)]">
                  {standards.map((standard) => (
                    <li key={standard.standard_id} className="flex flex-wrap items-baseline gap-[var(--s3)]">
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">
                        {standard.standard_name}
                      </span>
                      <span className="badge badge--filed">
                        <i aria-hidden="true">▣</i>{standard.recognition_kind.replace(/_/g, ' ')}
                      </span>
                      {standard.description ? (
                        <span className="t-body" style={{ fontSize: 'var(--t-sm)' }}>{standard.description}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s3)]">Someone met a standard</h2>
                <div className="grid gap-[var(--s3)] md:grid-cols-3">
                  <div className="field">
                    <label className="t-label" htmlFor="rec-standard">Standard</label>
                    <select id="rec-standard" className="select" value={recognizeForm.standard_id}
                      onChange={(e) => setRecognizeForm((f) => ({ ...f, standard_id: e.target.value }))}>
                      <option value="">Select…</option>
                      {standards.map((s) => (
                        <option key={s.standard_id} value={s.standard_id}>{s.standard_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="rec-athlete">Athlete</label>
                    <select id="rec-athlete" className="select" value={recognizeForm.athlete_id}
                      onChange={(e) => setRecognizeForm((f) => ({ ...f, athlete_id: e.target.value }))}>
                      <option value="">Select…</option>
                      {athletes.map((a) => (
                        <option key={a.athlete_id} value={a.athlete_id}>{a.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="rec-note">What happened (optional)</label>
                    <input id="rec-note" className="input" value={recognizeForm.note}
                      onChange={(e) => setRecognizeForm((f) => ({ ...f, note: e.target.value }))} />
                  </div>
                </div>
                <div className="mt-[var(--s3)]">
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleRecognize()}>
                    {busy ? 'Recording…' : 'Record recognition'}
                  </button>
                </div>
              </section>

              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-label mb-[var(--s2)]">Raise a concern</h2>
                <p className="t-body mb-[var(--s3)]" style={{ fontSize: 'var(--t-sm)' }}>
                  This goes to the safeguarding queue, not into a file on the athlete. An org admin
                  sees it, and it stays open until somebody resolves it on the record. If it is
                  urgent or unsafe, tell someone in person as well.
                </p>
                <div className="grid gap-[var(--s3)] md:grid-cols-3">
                  <div className="field">
                    <label className="t-label" htmlFor="con-athlete">Athlete</label>
                    <select id="con-athlete" className="select" value={concernForm.athlete_id}
                      onChange={(e) => setConcernForm((f) => ({ ...f, athlete_id: e.target.value }))}>
                      <option value="">Select…</option>
                      {athletes.map((a) => (
                        <option key={a.athlete_id} value={a.athlete_id}>{a.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="con-severity">How serious (your judgement)</label>
                    <select id="con-severity" className="select" value={concernForm.severity}
                      onChange={(e) => setConcernForm((f) => ({ ...f, severity: e.target.value }))}>
                      {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="con-reason">What happened</label>
                    <input id="con-reason" className="input" value={concernForm.reason}
                      onChange={(e) => setConcernForm((f) => ({ ...f, reason: e.target.value }))} />
                  </div>
                </div>
                <div className="mt-[var(--s3)]">
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void handleConcern()}>
                    Send to safeguarding
                  </button>
                </div>
              </section>
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
