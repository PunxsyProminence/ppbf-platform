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
 *
 * Ground is family canvas (T7), matching the index: a parent or a signed-out
 * visitor is who is reading, so there is no room wall behind the paper.
 */

interface StoreProduct {
  product_id: string;
  name: string;
  /**
   * The brand printed on the product, and public on purpose: a parent buying
   * gloves wants to know they are Everlast. This is NOT the gym's Everlast
   * account -- that is a separate, confidential record the route behind this
   * page does not select and this page has no field for.
   */
  brand: string;
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
    <main className="on-canvas min-h-screen">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)]">
        <Link href="/store" className="btn btn--ghost">
          All shops
        </Link>

        <header className="mt-[var(--s4)] space-y-[var(--s3)] border-b-[3px] border-[color:rgba(107,78,18,.28)] pb-[var(--s5)]">
          <p className="t-eyebrow">Shop</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>
            Equipment
          </h1>
          <p className="t-body">
            Every purchase supports the gym. Checkout is handled by our payment provider &mdash; your
            card details are never entered on this site.
          </p>
        </header>

        {!isLoaded ? (
          <div role="status" className="mt-[var(--s5)] space-y-[var(--s3)]">
            <p className="working">Loading the shop.</p>
            <div className="skeleton skeleton--block" />
            <div className="skeleton skeleton--block" />
          </div>
        ) : null}

        {errorMessage ? (
          <div role="alert" className="mt-[var(--s5)] flex flex-wrap items-center gap-[var(--s3)]">
            <span className="badge badge--filed">
              <i aria-hidden="true">✕</i>Could not load
            </span>
            <p className="t-body">{errorMessage}</p>
          </div>
        ) : null}

        {isLoaded && !errorMessage && products.length === 0 ? (
          <p className="t-body mt-[var(--s5)]">Nothing is on sale from this gym just now.</p>
        ) : null}

        {products.length > 0 ? (
          <ul className="mt-[var(--s5)] grid grid-cols-1 gap-[var(--s4)] md:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => {
              const purchasable = product.checkout_url !== '' && product.availability !== 'unavailable';
              return (
                <li
                  key={product.product_id}
                  className="mat-paper flex flex-col rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s5)]"
                >
                  <p className="t-eyebrow">{product.category}</p>
                  {product.brand ? <p className="t-label mt-[var(--s2)]">{product.brand}</p> : null}
                  <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>
                    {product.name}
                  </h2>
                  {product.description ? (
                    <p className="t-body mt-[var(--s2)]">{product.description}</p>
                  ) : null}

                  <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
                    {formatPrice(product.retail_price_cents)}
                  </p>
                  <p className="mt-[var(--s2)]">
                    <span className="badge badge--filed">
                      <i aria-hidden="true">▣</i>
                      {AVAILABILITY_LABEL[product.availability]}
                    </span>
                  </p>

                  <div className="mt-auto pt-[var(--s4)]">
                    {purchasable ? (
                      <a
                        href={product.checkout_url}
                        // Opens the processor's own hosted checkout. noopener is
                        // not optional on a target=_blank link: without it the
                        // opened page can reach back through window.opener.
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn w-full"
                      >
                        Buy
                      </a>
                    ) : (
                      <p className="t-body">Ask at the gym</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </main>
  );
}
