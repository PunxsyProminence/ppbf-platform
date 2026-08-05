'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/**
 * The gym's supplier accounts: who it buys from, on what account, on what
 * terms, and who to call.
 *
 * ORGANIZATION ADMIN ONLY. Everything on this screen is the gym's negotiated
 * commercial position -- the same confidence as the wholesale cost on the
 * catalogue page next door, and refused to the platform owner and to coaches
 * for the same reason.
 *
 * THIS IS NOT THE BRAND. The brand printed on a product ("Everlast") is public
 * and lives on the product, where the store shows it to a shopper. What lives
 * here is the gym's ACCOUNT with Everlast, which is a different fact with the
 * opposite audience.
 *
 * NO PASSWORD FIELD, AND THERE MUST NEVER BE ONE. A supplier portal login held
 * in this application would be a credential nobody rotates, readable by anyone
 * with an admin session, in a system built for youth records. What a Treasurer
 * needs on a screen to place an order is which account, where the portal is
 * and who to call -- so those are the fields, and the note below the form says
 * why the obvious missing one is missing. The route refuses a credential
 * outright rather than dropping it, so a form that grew one would fail loudly.
 */

interface Vendor {
  vendor_id: string;
  vendor_name: string;
  account_number: string;
  discount_tier: string;
  net_terms_days: number | null;
  portal_url: string;
  rep_name: string;
  rep_email: string;
  rep_phone: string;
  notes: string;
  active: boolean;
  product_count: number;
}

const FIELD_CLASS =
  'mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal';
const LABEL_CLASS =
  'block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]';

function VendorConsole() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [discountTier, setDiscountTier] = useState('');
  const [netTerms, setNetTerms] = useState('');
  const [portalUrl, setPortalUrl] = useState('');
  const [repName, setRepName] = useState('');
  const [repEmail, setRepEmail] = useState('');
  const [repPhone, setRepPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/gear-vendors`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; vendors?: Vendor[] };
      if (!response.ok) {
        throw new Error(payload.error || 'The supplier list could not be loaded.');
      }
      setVendors(payload.vendors ?? []);
      setLoadError('');
    } catch (error) {
      setVendors([]);
      setLoadError(error instanceof Error ? error.message : 'The supplier list could not be loaded.');
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  /** Load an existing supplier into the form, so this screen can edit and not only add. */
  function edit(vendor: Vendor) {
    setVendorId(vendor.vendor_id);
    setVendorName(vendor.vendor_name);
    setAccountNumber(vendor.account_number);
    setDiscountTier(vendor.discount_tier);
    setNetTerms(vendor.net_terms_days === null ? '' : String(vendor.net_terms_days));
    setPortalUrl(vendor.portal_url);
    setRepName(vendor.rep_name);
    setRepEmail(vendor.rep_email);
    setRepPhone(vendor.rep_phone);
    setNotes(vendor.notes);
    setActive(vendor.active);
    setSaved('');
    setSaveError('');
  }

  async function save() {
    setIsSaving(true);
    setSaveError('');
    setSaved('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/gear-vendors`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor_id: vendorId.trim(),
          vendor_name: vendorName.trim(),
          account_number: accountNumber.trim(),
          discount_tier: discountTier.trim(),
          // Empty stays null: "we have not recorded the terms" and "due on
          // receipt" are different facts, and sending 0 for both would tell a
          // Treasurer the second when the first is true.
          net_terms_days: netTerms.trim() === '' ? null : Number.parseInt(netTerms, 10),
          portal_url: portalUrl.trim(),
          rep_name: repName.trim(),
          rep_email: repEmail.trim(),
          rep_phone: repPhone.trim(),
          notes: notes.trim(),
          active,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'That could not be saved.');
      }
      setSaved('Saved.');
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  const canSave = vendorId.trim() !== '' && vendorName.trim() !== '' && !isSaving;
  const activeCount = vendors.filter((vendor) => vendor.active).length;

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="mx-auto max-w-4xl">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">Treasurer</p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Suppliers and accounts</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          Who the gym buys from, on what account and on what terms. Everything on this page is
          confidential and stays inside the gym &mdash; the public shop shows the brand on a
          product, never the account behind it.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin/gear"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            Back to equipment
          </Link>
          <Link
            href="/admin"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
          >
            Back to admin
          </Link>
        </div>

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="font-display text-xl font-black tracking-tight">Add or update a supplier</h2>

          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              Supplier id
              <input
                type="text" aria-label="Supplier id" value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                placeholder="everlast"
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Supplier name
              <input
                type="text" aria-label="Supplier name" value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="Everlast"
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Our account number
              <input
                type="text" aria-label="Our account number" value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Discount tier
              <input
                type="text" aria-label="Discount tier" value={discountTier}
                onChange={(e) => setDiscountTier(e.target.value)}
                placeholder="Tier 2 - 35% off list"
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Net terms (days)
              <input
                type="number" min="0" max="365" step="1" aria-label="Net terms in days" value={netTerms}
                onChange={(e) => setNetTerms(e.target.value)}
                className={FIELD_CLASS}
              />
              <span className="mt-1 block text-[11px] normal-case tracking-normal">
                Leave blank if the terms are not recorded. Zero means due on receipt.
              </span>
            </label>
            <label className={LABEL_CLASS}>
              Ordering portal
              <input
                type="url" aria-label="Ordering portal" value={portalUrl}
                onChange={(e) => setPortalUrl(e.target.value)}
                placeholder="https://..."
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Rep name
              <input
                type="text" aria-label="Rep name" value={repName}
                onChange={(e) => setRepName(e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Rep email
              <input
                type="email" aria-label="Rep email" value={repEmail}
                onChange={(e) => setRepEmail(e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              Rep phone
              <input
                type="tel" aria-label="Rep phone" value={repPhone}
                onChange={(e) => setRepPhone(e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </div>

          <label className={`mt-4 ${LABEL_CLASS}`}>
            Notes
            <textarea
              aria-label="Notes" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 h-20 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm normal-case tracking-normal"
            />
          </label>

          <label className="mt-4 flex items-center gap-3 text-sm">
            <input
              type="checkbox" aria-label="We still buy from this supplier" checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-5 w-5 border-2 border-[var(--black)]"
            />
            <span>
              We still buy from this supplier
              <span className="block text-[11px] text-[var(--gray-dark)]">
                Untick rather than delete. The products bought on this account still reference it.
              </span>
            </span>
          </label>

          {/* Stated on the screen, not only in the code, so an admin looking
              for the password field learns why there is not one instead of
              concluding the form is unfinished. */}
          <p className="mt-4 border-l-4 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm leading-6">
            <strong>No portal password.</strong> This platform never stores a supplier login. A
            password saved here would be readable by everyone with an admin account and would sit
            in the same database as our athletes&rsquo; records. Keep it wherever the gym already
            keeps its passwords, and sign in at the portal link above.
          </p>

          <button
            type="button" disabled={!canSave}
            onClick={() => { void save(); }}
            className="mt-4 min-h-[44px] w-full border-2 border-[var(--black)] bg-[color:var(--brass-800)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save supplier'}
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
            Suppliers{isLoaded ? ` (${vendors.length}, ${activeCount} current)` : ''}
          </h2>

          {loadError ? (
            <p className="mt-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">{loadError}</p>
          ) : null}
          {isLoaded && !loadError && vendors.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
              No suppliers recorded yet.
            </p>
          ) : null}

          <ul className="mt-3 grid gap-3">
            {vendors.map((vendor) => (
              <li key={vendor.vendor_id} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                  <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                    {vendor.active ? 'Current' : 'Past supplier'}
                  </span>
                  <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                    {vendor.product_count} {vendor.product_count === 1 ? 'product' : 'products'}
                  </span>
                </div>

                <p className="mt-2"><strong>{vendor.vendor_name}</strong> &middot; {vendor.vendor_id}</p>
                <p className="mt-1 leading-6">
                  {vendor.account_number ? `Account ${vendor.account_number}` : 'No account number recorded'}
                  {vendor.discount_tier ? ` - ${vendor.discount_tier}` : ''}
                  {vendor.net_terms_days === null
                    ? ' - terms not recorded'
                    : ` - net ${vendor.net_terms_days} days`}
                </p>
                {vendor.rep_name || vendor.rep_email || vendor.rep_phone ? (
                  <p className="mt-1 leading-6">
                    {[vendor.rep_name, vendor.rep_email, vendor.rep_phone].filter(Boolean).join(' - ')}
                  </p>
                ) : null}
                {vendor.notes ? (
                  <p className="mt-1 leading-6 text-[var(--gray-dark)]">{vendor.notes}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-3">
                  {vendor.portal_url ? (
                    <a
                      href={vendor.portal_url}
                      target="_blank"
                      // noopener is not optional on target=_blank: without it
                      // the opened page can reach back through window.opener.
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.12em]"
                    >
                      Open portal
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => edit(vendor)}
                    className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 text-xs font-bold uppercase tracking-[0.12em]"
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

export default function GearVendorsPage() {
  // Matches the route: organization_admin only. An account number and a
  // negotiated discount tier are the gym's commercial position, and the
  // platform owner is refused them across gyms for the same reason it is
  // refused athlete records.
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <VendorConsole />
    </RoleSessionGate>
  );
}
