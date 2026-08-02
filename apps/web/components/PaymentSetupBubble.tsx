'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// The prompt that walks an admin through switching payments on, and takes
// itself away when there is nothing left to do.
//
// It renders NOTHING in three cases: setup is complete, the status could not be
// read, or the reply carried no steps. That is deliberate -- a setup prompt
// that lingers after setup, or that appears as an error box when the check
// fails, trains people to ignore it. Silence is the correct failure mode for a
// hint; the console around it does not depend on this call.

interface PaymentSetupStatus {
  ready?: boolean;
  enabled?: boolean;
  lanes?: Record<string, string>;
  remainingSteps?: string[];
}

export default function PaymentSetupBubble() {
  const [steps, setSteps] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/payments/setup-status`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;

        const payload = (await response.json()) as PaymentSetupStatus;
        if (controller.signal.aborted) return;
        if (payload.ready) return;

        setSteps(Array.isArray(payload.remainingSteps) ? payload.remainingSteps : []);
      } catch {
        // A hint is never worth an error state. Staying quiet leaves the
        // console exactly as it would have been without this component.
      }
    })();

    return () => controller.abort();
  }, []);

  if (dismissed || steps.length === 0) {
    return null;
  }

  return (
    <aside
      className="rounded-2xl border-2 border-[var(--brass-dark)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-md)]"
      aria-labelledby="payment-setup-heading"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-mono font-bold uppercase tracking-[0.3em] text-[var(--safety-locked)]">
            Setup
          </p>
          <h2 id="payment-setup-heading" className="mt-1 text-lg font-black tracking-tight text-[var(--black)]">
            Finish connecting payments
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="min-h-[44px] shrink-0 rounded-full border border-[rgba(0,0,0,0.2)] px-3 text-[10px] font-mono font-bold uppercase tracking-[0.1em] text-[var(--gray-dark)] transition hover:bg-white"
          aria-label="Hide the payment setup steps until the next page load"
        >
          Hide
        </button>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-[var(--gray-dark)]">
        Donations and program payments settle into two separate Stripe accounts, so each one
        connects on its own. This panel disappears once both are connected.
      </p>

      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm leading-relaxed text-[var(--black)]">
            <span
              aria-hidden="true"
              className="mt-[2px] grid size-5 shrink-0 place-items-center rounded-full border border-[var(--black)] bg-white text-[10px] font-mono font-bold"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
