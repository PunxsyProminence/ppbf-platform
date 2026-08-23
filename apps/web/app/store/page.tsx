'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';

/**
 * The index of gyms with a store.
 *
 * Public: no session, no gate, no cookie. It shows organization names and
 * nothing else, and the page it links to shows equipment and prices. Nothing
 * about a child is reachable from here, and nothing ever should be -- this and
 * the store page are the only surfaces on the platform that answer without
 * asking who is calling.
 *
 * It exists so this is multi-store from the first commit rather than one gym's
 * shop with a general-sounding URL. Other gyms on the platform have their own
 * suppliers, their own prices and their own catalogue.
 *
 * Ground is family canvas (T7), not a room wall: the same audience that reads
 * /help and /public reads this one, and they are not signed in.
 */

interface StoreSummary {
  organization_id: string;
  organization_name: string;
  listed_product_count: number;
}

export default function StoreIndexPage() {
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/public/store`, { method: 'GET', credentials: 'omit' });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          stores?: StoreSummary[];
        };
        if (!response.ok) {
          throw new Error(payload.error || 'The shop could not be loaded.');
        }
        setStores(payload.stores ?? []);
        setErrorMessage('');
      } catch (error) {
        setStores([]);
        setErrorMessage(error instanceof Error ? error.message : 'The shop could not be loaded.');
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  return (
    <main className="on-canvas min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-[var(--s5)] py-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:rgba(107,78,18,.28)] pb-[var(--s5)]">
          <p className="t-eyebrow">Shop</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>
            Equipment
          </h1>
          <p className="t-body">Buying gear here supports the gym directly.</p>
        </header>

        {!isLoaded ? (
          /* Law 3: a bare spinner is colour-and-motion-only and is banned.
             .working already carries the glyph; the label is the sentence. */
          <div role="status" className="mt-[var(--s5)] space-y-[var(--s3)]">
            <p className="working">Loading the shop.</p>
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--line" />
            <div className="skeleton skeleton--block" />
          </div>
        ) : null}

        {errorMessage ? (
          /* Administrative, not safety: a shop that failed to load is not a
             gate. .badge--filed is the rung that is allowed on a public page.
             The sentence below is the load-bearing copy and is not reworded. */
          <div role="alert" className="mt-[var(--s5)] flex flex-wrap items-center gap-[var(--s3)]">
            <span className="badge badge--filed">
              <i aria-hidden="true">✕</i>Could not load
            </span>
            <p className="t-body">{errorMessage}</p>
          </div>
        ) : null}

        {/*
          A loaded-and-empty shop and a shop that failed to load are different
          facts. Saying "no gyms are selling anything" because a request failed
          would be a shop that looks closed when it is not.
        */}
        {isLoaded && !errorMessage && stores.length === 0 ? (
          <p className="t-body mt-[var(--s5)]">Nothing is on sale just now. Check back.</p>
        ) : null}

        {stores.length > 0 ? (
          <ul className="mt-[var(--s5)] grid gap-[var(--s3)]">
            {stores.map((store) => (
              <li key={store.organization_id}>
                <Link
                  href={`/store/${encodeURIComponent(store.organization_id)}`}
                  className="mat-paper flex min-h-[44px] min-w-[44px] items-center justify-between rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] px-[var(--s4)] py-[var(--s3)]"
                >
                  <span className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                    {store.organization_name}
                  </span>
                  <span className="t-data">
                    {store.listed_product_count} item{store.listed_product_count === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}
