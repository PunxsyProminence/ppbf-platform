'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/**
 * The gym's equipment catalogue: what it paid, what it charges, what is on sale.
 *
 * This is the Treasurer-facing side of the store. It is the only place the
 * wholesale cost appears, and it is organization-admin only -- the cost is the
 * gym's negotiated position with a supplier, not the platform owner's to read
 * across gyms and not a coach's either.
 *
 * A product can live here and never be for sale. That is the normal case: most
 * equipment a gym buys at wholesale is for its own use, and the cost register
 * is worth having whether or not anything is sold on.
 *
 * MONEY IS ENTERED IN DOLLARS AND SENT AS WHOLE CENTS. The conversion happens
 * once, here, deliberately: a form that posts "12.99" to a server that
 * multiplies by 100 produces 1298.9999999999998, and a catalogue that drifts a
 * cent per edit gives a Treasurer a margin report that will not reconcile.
 */

interface GearProduct {
  product_id: string;
  name: string;
  description: string;
  category: string;
  wholesale_cost_cents: number;
  retail_price_cents: number;
  listed_publicly: boolean;
  availability: string;
  checkout_url: string;
  margin_cents: number;
  margin_percent: number | null;
}

const AVAILABILITY = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'order_only', label: 'To order' },
  { value: 'unavailable', label: 'Not available' },
];

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100)}.${(abs % 100).toString().padStart(2, '0')}`;
}

/** Dollars typed by a person to whole cents. Rounded, never truncated. */
function dollarsToCents(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
}

function GearCatalogueConsole() {
  const [items, setItems] = useState<GearProduct[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [productId, setProductId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [cost, setCost] = useState('');
  const [price, setPrice] = useState('');
  const [listed, setListed] = useState(false);
  const [availability, setAvailability] = useState('in_stock');
  const [checkoutUrl, setCheckoutUrl] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/gear`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; items?: GearProduct[] };
      if (!response.ok) {
        throw new Error(payload.error || 'The catalogue could not be loaded.');
      }
      setItems(payload.items ?? []);
      setLoadError('');
    } catch (error) {
      setItems([]);
      setLoadError(error instanceof Error ? error.message : 'The catalogue could not be loaded.');
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  async function save() {
    setIsSaving(true);
    setSaveError('');
    setSaved('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/gear`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: productId.trim(),
          name: name.trim(),
          description: description.trim(),
          category: category.trim(),
          wholesale_cost_cents: dollarsToCents(cost || '0'),
          retail_price_cents: dollarsToCents(price || '0'),
          listed_publicly: listed,
          availability,
          checkout_url: checkoutUrl.trim(),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'That could not be saved.');
      }
      setSaved('Saved.');
      setProductId('');
      setName('');
      setDescription('');
      setCost('');
      setPrice('');
      setCheckoutUrl('');
      setListed(false);
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  const canSave = productId.trim() !== '' && name.trim() !== '' && !isSaving;
  const listedCount = items.filter((item) => item.listed_publicly).length;

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="mx-auto max-w-4xl">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">Treasurer</p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Equipment and margin</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          What the gym paid, what it charges, and what is on public sale. The cost is visible only
          here &mdash; the public store never receives it.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            Back to admin
          </Link>
          <Link
            href="/store"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            See the public shop
          </Link>
        </div>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="font-display text-xl font-black tracking-tight">Add or update an item</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              Product id
              <input
                type="text" aria-label="Product id" value={productId}
                onChange={(e) => setProductId(e.target.value)}
                placeholder="gloves-12oz"
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              />
            </label>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              Name
              <input
                type="text" aria-label="Name" value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              />
            </label>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              What we pay
              <input
                type="number" step="0.01" min="0" aria-label="What we pay" value={cost}
                onChange={(e) => setCost(e.target.value)}
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              />
            </label>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              What we charge
              <input
                type="number" step="0.01" min="0" aria-label="What we charge" value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              />
            </label>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              Category
              <input
                type="text" aria-label="Category" value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              />
            </label>
            <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
              Availability
              <select
                aria-label="Availability" value={availability}
                onChange={(e) => setAvailability(e.target.value)}
                className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
              >
                {AVAILABILITY.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-4 block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Description
            <textarea
              aria-label="Description" value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 h-20 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm normal-case tracking-normal"
            />
          </label>

          <label className="mt-4 block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Checkout link (from the payment provider)
            <input
              type="url" aria-label="Checkout link" value={checkoutUrl}
              onChange={(e) => setCheckoutUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
            />
          </label>

          <label className="mt-4 flex items-center gap-3 text-sm">
            <input
              type="checkbox" aria-label="Sell this on the public shop" checked={listed}
              onChange={(e) => setListed(e.target.checked)}
              className="h-5 w-5 border-2 border-[var(--black)]"
            />
            <span>
              Sell this on the public shop
              <span className="block text-[11px] text-[var(--gray-dark)]">
                Leave unticked for equipment the gym buys for its own use.
              </span>
            </span>
          </label>

          <button
            type="button" disabled={!canSave}
            onClick={() => { void save(); }}
            className="mt-4 min-h-[44px] w-full border-2 border-[var(--black)] bg-[color:var(--brass-800)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save item'}
          </button>

          {saveError ? (
            <p className="mt-3 border-l-4 border-[color:var(--rust-500)] bg-[var(--canvas-tan)] px-3 py-2 text-sm">{saveError}</p>
          ) : null}
          {saved ? (
            <p className="mt-3 border-l-4 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm">{saved}</p>
          ) : null}
        </section>

        <section className="mt-6">
          <h2 className="font-display text-xl font-black tracking-tight">
            The catalogue{isLoaded ? ` (${items.length}, ${listedCount} on sale)` : ''}
          </h2>

          {loadError ? (
            <p className="mt-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">{loadError}</p>
          ) : null}
          {isLoaded && !loadError && items.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">Nothing in the catalogue yet.</p>
          ) : null}

          <ul className="mt-3 grid gap-3">
            {items.map((item) => (
              <li key={item.product_id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                  <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">{item.category}</span>
                  <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                    {item.listed_publicly ? 'On sale' : 'Club use'}
                  </span>
                  {item.listed_publicly && !item.checkout_url ? (
                    <span className="border-2 border-[color:var(--rust-500)] bg-[var(--canvas-tan)] px-2 py-1 text-[color:var(--rust-500)]">
                      No checkout link
                    </span>
                  ) : null}
                </div>
                <p className="mt-2"><strong>{item.name}</strong> &middot; {item.product_id}</p>
                <p className="mt-1 leading-6">
                  Paid {formatMoney(item.wholesale_cost_cents)} &middot; charging {formatMoney(item.retail_price_cents)} &middot;{' '}
                  <strong className={item.margin_cents < 0 ? 'text-[color:var(--rust-500)]' : undefined}>
                    {formatMoney(item.margin_cents)}
                    {item.margin_percent !== null ? ` (${item.margin_percent}%)` : ''}
                  </strong>
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

export default function GearCataloguePage() {
  // Matches the route: organization_admin only. The wholesale cost is
  // commercial confidence, and the platform owner is refused it across gyms for
  // the same reason it is refused athlete records.
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <GearCatalogueConsole />
    </RoleSessionGate>
  );
}
