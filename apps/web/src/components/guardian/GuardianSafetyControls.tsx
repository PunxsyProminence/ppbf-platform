'use client';

import { useState } from 'react';

export default function GuardianSafetyControls() {
  const [mediaConsent, setMediaConsent] = useState(false);
  const [directMessagingConsent, setDirectMessagingConsent] = useState(false);
  const [homeObservation, setHomeObservation] = useState('');

  return (
    <section className="border border-zinc-800 rounded-none bg-black p-4">
      <header className="mb-4 border border-zinc-800 rounded-none bg-black p-4">
        <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Role 2 Guardian / Parent View</p>
        <h1 className="mt-2 text-lg uppercase tracking-[0.12em] text-slate-200">Layer 11 Safety Gates</h1>
      </header>

      <div className="space-y-3">
        <label className="flex items-start gap-3 border border-zinc-800 rounded-none bg-black p-4 text-sm">
          <input
            type="checkbox"
            checked={mediaConsent}
            onChange={(event) => setMediaConsent(event.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>MEDIA / VIDEO CONSENT: Authorized for public gym marketing</span>
        </label>

        <label className="flex items-start gap-3 border border-zinc-800 rounded-none bg-black p-4 text-sm">
          <input
            type="checkbox"
            checked={directMessagingConsent}
            onChange={(event) => setDirectMessagingConsent(event.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>DIRECT MESSAGING: Allow 1-on-1 coach/athlete text communication (Default: OFF / BLOCKED)</span>
        </label>
      </div>

      <div className="mt-4 border border-zinc-800 rounded-none bg-black p-4">
        <label htmlFor="guardian-home-observation" className="block text-sm text-slate-300">
          Submit Home Observation / Safety Concern
        </label>
        <textarea
          id="guardian-home-observation"
          value={homeObservation}
          onChange={(event) => setHomeObservation(event.target.value)}
          rows={4}
          className="mt-2 w-full border border-zinc-800 rounded-none bg-[#09090b] p-2 text-sm text-slate-200"
        />
      </div>

      <p className="mt-4 animate-pulse text-[#b91c1c] text-sm uppercase tracking-[0.08em]">
        YOUTH PROTECTION PROTOCOL ACTIVE: All digital communications are logged and CC&apos;d to the Program &amp; Safety Director.
      </p>
    </section>
  );
}
