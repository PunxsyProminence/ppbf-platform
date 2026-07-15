'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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
        const response = await fetch('/api/pilot/shadow/observation-projection', {
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
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
        <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">Coach Workspace</p>
          <h1 className="font-display text-4xl font-black">Sports Medicine</h1>
          <p className="text-sm font-mono uppercase tracking-[0.14em] text-[var(--red-primary)]">PLANNED | NOT YET IMPLEMENTED</p>
          <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            Front-end scaffold for future sports medicine workflows. No medical automation, diagnosis logic, or backend processing is implemented.
          </p>
        </header>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {errorMessage ? (
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 md:col-span-2 xl:col-span-3">
              <h2 className="text-sm font-bold uppercase tracking-[0.08em]">SHADOW Observation Stream</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{errorMessage}</p>
            </article>
          ) : null}

          {!errorMessage && items.length === 0 ? (
            <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 md:col-span-2 xl:col-span-3">
              <h2 className="text-sm font-bold uppercase tracking-[0.08em]">SHADOW Observation Stream</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">No SHADOW observation items are available yet.</p>
            </article>
          ) : null}

          {items.map((item) => (
            <article key={item.id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{item.label}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">Source: {item.source}</p>
              <p className="text-sm leading-6 text-[var(--gray-dark)]">Review State: {item.review_state}</p>
              <p className="text-xs leading-6 text-[var(--gray-dark)]">Entity: {item.entity_type || 'n/a'} / {item.entity_id || 'n/a'}</p>
            </article>
          ))}
        </section>

        <div className="mt-8">
          <Link
            href="/operations"
            className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
          >
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}
