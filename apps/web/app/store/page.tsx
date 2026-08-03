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
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-10 text-[var(--black)]">
      <div className="mx-auto max-w-3xl">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">Shop</p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Equipment</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          Buying gear here supports the gym directly.
        </p>

        {errorMessage ? (
          <p className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">
            {errorMessage}
          </p>
        ) : null}

        {/*
          A loaded-and-empty shop and a shop that failed to load are different
          facts. Saying "no gyms are selling anything" because a request failed
          would be a shop that looks closed when it is not.
        */}
        {isLoaded && !errorMessage && stores.length === 0 ? (
          <p className="mt-6 text-sm leading-6 text-[var(--gray-dark)]">
            Nothing is on sale just now. Check back.
          </p>
        ) : null}

        <ul className="mt-6 grid gap-3">
          {stores.map((store) => (
            <li key={store.organization_id}>
              <Link
                href={`/store/${encodeURIComponent(store.organization_id)}`}
                className="flex min-h-[44px] items-center justify-between border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 py-3 text-sm font-bold"
              >
                <span>{store.organization_name}</span>
                <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                  {store.listed_product_count} item{store.listed_product_count === 1 ? '' : 's'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
