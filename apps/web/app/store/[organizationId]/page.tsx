'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';

/**
 * One gym's public store.
 *
 * Public: no session, no gate. Every price shown here is the retail price. The
 * wholesale cost is never fetched by the route behind this page -- it is not
 * hidden in the payload, it is absent from the query -- because what the gym
 * paid its supplier is not the public's to see and may be something the
 * supplier agreement forbids disclosing.
 *
 * Checkout is hosted elsewhere. This page links out; it never collects a card,
 * an address or a name. That keeps the platform's PCI scope where the payment
 * slot doc requires it and means a shopper hands their details to a processor
 * rather than to a youth sports application.
 *
 * A product with no checkout link is shown and marked as not purchasable
 * online, which is the honest state before a processor account exists rather
 * than a dead button.
 */

interface StoreProduct {
  product_id: string;
  name: string;
  description: string;
  category: string;
  retail_price_cents: number;
  availability: 'in_stock' | 'order_only' | 'unavailable';
  checkout_url: string;
}

const AVAILABILITY_LABEL: Record<StoreProduct['availability'], string> = {
  in_stock: 'In stock',
  order_only: 'To order',
  unavailable: 'Not available just now',
};

/** Cents to a displayed price. Integer arithmetic throughout; no float ever. */
function formatPrice(cents: number): string {
  const dollars = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100).toString().padStart(2, '0');
  return `$${dollars}.${remainder}`;
}

export default function GymStorePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/public/store?organization_id=${encodeURIComponent(organizationId)}`,
          { method: 'GET', credentials: 'omit' },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          products?: StoreProduct[];
        };
        if (!response.ok) {
          throw new Error(payload.error || 'The shop could not be loaded.');
        }
        setProducts(payload.products ?? []);
        setErrorMessage('');
      } catch (error) {
        setProducts([]);
        setErrorMessage(error instanceof Error ? error.message : 'The shop could not be loaded.');
      } finally {
        setIsLoaded(true);
      }
    })();
  }, [organizationId]);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-10 text-[var(--black)]">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/store"
          className="inline-flex min-h-[44px] items-center text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]"
        >
          &larr; All shops
        </Link>

        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Equipment</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          Every purchase supports the gym. Checkout is handled by our payment provider &mdash; your
          card details are never entered on this site.
        </p>

        {errorMessage ? (
          <p className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">
            {errorMessage}
          </p>
        ) : null}

        {isLoaded && !errorMessage && products.length === 0 ? (
          <p className="mt-6 text-sm leading-6 text-[var(--gray-dark)]">
            Nothing is on sale from this gym just now.
          </p>
        ) : null}

        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {products.map((product) => {
            const purchasable = product.checkout_url !== '' && product.availability !== 'unavailable';
            return (
              <li
                key={product.product_id}
                className="flex flex-col border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4"
              >
                <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                  {product.category}
                </p>
                <h2 className="mt-1 font-display text-lg font-black tracking-tight">{product.name}</h2>
                {product.description ? (
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{product.description}</p>
                ) : null}

                <p className="mt-3 font-display text-2xl font-black">
                  {formatPrice(product.retail_price_cents)}
                </p>
                <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                  {AVAILABILITY_LABEL[product.availability]}
                </p>

                <div className="mt-auto pt-4">
                  {purchasable ? (
                    <a
                      href={product.checkout_url}
                      // Opens the processor's own hosted checkout. noopener is
                      // not optional on a target=_blank link: without it the
                      // opened page can reach back through window.opener.
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] w-full items-center justify-center border-2 border-[var(--black)] bg-[color:var(--brass-800)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)]"
                    >
                      Buy
                    </a>
                  ) : (
                    <p className="inline-flex min-h-[44px] w-full items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 text-center text-xs font-bold uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                      Ask at the gym
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
