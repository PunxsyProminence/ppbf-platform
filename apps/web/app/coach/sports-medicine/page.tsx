'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

export default function SportsMedicinePage() {
  const [items, setItems] = useState<ShadowObservationItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 30 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW observation projection.');
        }

        const payload = (await response.json()) as { items?: ShadowObservationItem[] };
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW observation projection.');
      }
    })();
  }, []);

  return (
    <main className="room--clinic min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command text-[length:var(--t-2xl)]">Sports Medicine</h1>
          <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
          <p className="t-body max-w-4xl text-[color:var(--bone-300)]">
            Front-end scaffold for future sports medicine workflows. No medical automation, diagnosis logic, or backend processing is implemented.
          </p>
        </header>

        <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
          {errorMessage ? (
            <article className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] md:col-span-2 xl:col-span-3">
              <h2 className="t-eyebrow">SHADOW Observation Stream</h2>
              <p className="t-body mt-[var(--s3)] text-[var(--locked-ink)]">{errorMessage}</p>
            </article>
          ) : null}

          {!errorMessage && items.length === 0 ? (
            <article className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] md:col-span-2 xl:col-span-3">
              <h2 className="t-eyebrow">SHADOW Observation Stream</h2>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No SHADOW observation items are available yet.</p>
            </article>
          ) : null}

          {items.map((item) => (
            <article key={item.id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-eyebrow">{item.label}</h2>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Source: {item.source}</p>
              <p className="t-body text-[color:var(--bone-300)]">Review State: {item.review_state}</p>
              <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">Entity: {item.entity_type || 'n/a'} / {item.entity_id || 'n/a'}</p>
            </article>
          ))}
        </section>

        <div className="mt-[var(--s6)]">
          <Link href="/operations" className="btn btn--ghost">
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}
