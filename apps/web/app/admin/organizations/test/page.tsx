'use client';

import { useState } from 'react';

type FeedbackKind = 'success' | 'error' | 'info';

const gymCapabilities = [
  { id: 'attendance', label: 'Check-in & Check-out', description: 'Track who is at the gym and when they arrive/leave.' },
  { id: 'coach-notes', label: 'Coach Notes', description: 'Let coaches write and save private notes about athlete progress.' },
  { id: 'progression', label: 'Progress Tracking', description: 'Show gym admins a summary of how athletes are improving.' },
  { id: 'announcements', label: 'Gym Announcements', description: 'Post messages to all gym members (schedule changes, events, etc.).' },
  { id: 'sparring', label: 'Sparring & Safety Tools', description: 'Track and manage sparring sessions with safety guidelines.' },
  { id: 'publication', label: 'Content Publishing', description: 'Allow coaches to share videos, photos, and updates.' },
];

// The disabled-route notice lives in this wrapper rather than as an early
// return inside the wizard itself. The wizard body opens with ten useState
// calls, so returning before them made hook order depend on
// NEXT_PUBLIC_PPBF_ENABLE_TEST_WIZARD -- a rules-of-hooks violation that failed
// lint and would break if the flag were ever read from anything but a
// build-time constant. Gating at the component boundary also means the disabled
// path initializes no wizard state at all.
export default function SetupWizard() {
  const testWizardEnabled = process.env.NEXT_PUBLIC_PPBF_ENABLE_TEST_WIZARD === 'true';

  if (!testWizardEnabled) {
    return (
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-12 lg:px-10">
          <header className="rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-md)]">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--accent-quiet)]">Setup Wizard</p>
            <h1 className="mt-2 font-display text-3xl font-black">Test Wizard Disabled</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--gray-dark)]">
              This unauthenticated simulation route is disabled by default. Set NEXT_PUBLIC_PPBF_ENABLE_TEST_WIZARD=true only in controlled non-production environments.
            </p>
          </header>
        </div>
      </main>
    );
  }

  return <SetupWizardContent />;
}

function SetupWizardContent() {
  const [step, setStep] = useState(1);

  // Step 1: Create Gym
  const [gymId, setGymId] = useState('');
  const [gymName, setGymName] = useState('');

  // Step 2: Create Admin Account
  const [adminAccountId, setAdminAccountId] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [adminConfirmPin, setAdminConfirmPin] = useState('');

  // Step 3: Configure Features
  const [gymCapabilityAccess, setGymCapabilityAccess] = useState<Record<string, boolean>>({});

  // UI State
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; text: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);

  function showFeedback(kind: FeedbackKind, text: string) {
    setFeedback({ kind, text });
    if (kind === 'success') {
      setTimeout(() => setFeedback(null), 3000);
    }
  }

  async function runAction(action: () => Promise<string>) {
    setIsBusy(true);
    setFeedback(null);
    try {
      const msg = await action();
      showFeedback('success', msg);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Something went wrong';
      showFeedback('error', msg);
      return false;
    } finally {
      setIsBusy(false);
    }
  }

  async function createGym() {
    if (!gymId.trim() || !gymName.trim()) {
      throw new Error('Please enter both a gym ID and gym name');
    }
    // Simulating API call
    await new Promise(resolve => setTimeout(resolve, 1000));
    return `Gym "${gymName}" created successfully!`;
  }

  async function createAdminAccount() {
    if (!adminAccountId.trim()) throw new Error('Please enter an Admin Account ID');
    if (!adminPin.trim()) throw new Error('Please enter a PIN code');
    if (adminPin !== adminConfirmPin) throw new Error('PINs do not match');
    if (adminPin.length < 4) throw new Error('PIN must be at least 4 characters');

    // Simulating API call
    await new Promise(resolve => setTimeout(resolve, 1000));
    return `Admin account "${adminAccountId}" created successfully!`;
  }

  async function saveCapabilities() {
    const enabledCapabilities = Object.entries(gymCapabilityAccess)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);

    // Simulating API call
    await new Promise(resolve => setTimeout(resolve, 1000));
    return `Saved ${enabledCapabilities.length} features for your gym`;
  }

  const canStep1 = gymId.trim() && gymName.trim();
  const canStep2 = adminAccountId.trim() && adminPin.trim() && adminPin === adminConfirmPin && adminPin.length >= 4;
  const step1Complete = completedSteps.includes(1);
  const step2Complete = completedSteps.includes(2);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12 lg:px-10">
        {/* Test Banner */}
        <div className="rounded-lg border-2 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,white)] p-4">
          <p className="text-sm font-semibold text-[var(--accent-quiet)]">🧪 TEST MODE - No authentication required. Form submissions are simulated.</p>
        </div>

        {/* Header */}
        <header className="space-y-4 rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--accent-quiet)]">Setup Wizard</p>
          <h1 className="font-display text-4xl font-black">Get Your Gym Online</h1>
          <p className="text-base leading-7 text-[var(--gray-dark)]">
            Follow these 3 simple steps to set up your gym in PPBF and start managing athletes.
          </p>
        </header>

        {/* Progress Indicator */}
        <div className="flex items-center justify-between gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 font-bold transition ${
                  s < step
                    ? 'border-[var(--accent)] bg-[var(--accent-strong)] text-[var(--accent-ink)]'
                    : s === step
                      ? 'border-[var(--accent)] bg-white text-[var(--accent-quiet)]'
                      : 'border-[rgba(0,0,0,0.14)] bg-white text-[var(--gray-dark)]'
                }`}
              >
                {s < step ? '✓' : s}
              </div>
              {s < 3 && <div className={`flex-1 h-1 rounded ${s < step ? 'bg-[var(--accent-strong)]' : 'bg-[rgba(0,0,0,0.08)]'}`} />}
            </div>
          ))}
        </div>

        {/* Feedback Message */}
        {feedback && (
          <div
            className={`rounded-xl border px-4 py-3 ${
              feedback.kind === 'error'
                ? 'border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_5%,white)]'
                : feedback.kind === 'success'
                  ? 'border-[var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_8%,white)]'
                  : 'border-[var(--gray-medium)] bg-[rgba(0,0,0,0.03)]'
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                feedback.kind === 'error'
                  ? 'text-[var(--safety-locked)]'
                  : feedback.kind === 'success'
                    ? 'text-[var(--cleared-deep)]'
                    : 'text-[var(--gray-dark)]'
              }`}
            >
              {feedback.kind === 'error' && '❌ '}{feedback.kind === 'success' && '✓ '}{feedback.text}
            </p>
          </div>
        )}

        {/* Step 1: Create Gym */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 1
              ? 'border-[var(--accent)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--accent)_15%,white)]'
              : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-lg font-bold">Step 1: Create Your Gym Profile</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Give your gym a unique ID and friendly name. This is how PPBF identifies your organization.
              </p>
            </div>
            {step1Complete && <span className="text-2xl">✓</span>}
          </div>

          {step === 1 && (
            <div className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Gym ID (Short Code)</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">Use lowercase letters and numbers, no spaces. Example: &quot;golden_boxing&quot;</p>
                <input
                  type="text"
                  value={gymId}
                  onChange={(e) => setGymId(e.target.value.toLowerCase())}
                  placeholder="golden_boxing"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Gym Name (Display Name)</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">The full name of your gym as you&apos;d like it to appear.</p>
                <input
                  type="text"
                  value={gymName}
                  onChange={(e) => setGymName(e.target.value)}
                  placeholder="Golden Boxing Studio"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <button
                type="button"
                disabled={!canStep1 || isBusy}
                onClick={async () => {
                  const success = await runAction(createGym);
                  if (success) {
                    setCompletedSteps([...completedSteps, 1]);
                    setStep(2);
                  }
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--accent)] bg-[var(--accent-strong)] px-4 font-bold uppercase tracking-[0.1em] text-[var(--accent-ink)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Gym & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Create Admin Account */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 2
              ? 'border-[var(--accent)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--accent)_15%,white)]'
              : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-lg font-bold">Step 2: Create Your Admin Account</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                This will be your first user account. You&apos;ll use the Account ID and PIN to sign in to PPBF.
              </p>
            </div>
            {step2Complete && <span className="text-2xl">✓</span>}
          </div>

          {step === 2 && (
            <div className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Your Account ID</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">A unique identifier for you. Example: &quot;coach-john&quot; or &quot;admin-001&quot;</p>
                <input
                  type="text"
                  value={adminAccountId}
                  onChange={(e) => setAdminAccountId(e.target.value)}
                  placeholder="coach-john"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">PIN (4+ digits)</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">A secure PIN code you&apos;ll use to sign in. Example: 1234 or 9876</p>
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => setAdminPin(e.target.value)}
                  placeholder="••••"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Confirm PIN</label>
                <input
                  type="password"
                  value={adminConfirmPin}
                  onChange={(e) => setAdminConfirmPin(e.target.value)}
                  placeholder="••••"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <button
                type="button"
                disabled={!canStep2 || isBusy}
                onClick={async () => {
                  const success = await runAction(createAdminAccount);
                  if (success) {
                    setCompletedSteps([...completedSteps, 2]);
                    setStep(3);
                  }
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--accent)] bg-[var(--accent-strong)] px-4 font-bold uppercase tracking-[0.1em] text-[var(--accent-ink)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Admin Account & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 3: Configure Features */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 3 ? 'border-[var(--accent)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--accent)_15%,white)]' : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
          }`}
        >
          <div className="flex-1">
            <h2 className="text-lg font-bold">Step 3: Choose Your Features</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
              Select which tools your gym wants to use. You can always change these later.
            </p>
          </div>

          {step === 3 && (
            <div className="mt-6 space-y-4">
              <div className="space-y-3">
                {gymCapabilities.map(({ id, label, description }) => (
                  <label key={id} className="flex items-start gap-3 rounded-lg border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] p-4 cursor-pointer hover:border-[var(--accent)] transition">
                    <input
                      type="checkbox"
                      checked={gymCapabilityAccess[id] ?? false}
                      onChange={(e) =>
                        setGymCapabilityAccess({
                          ...gymCapabilityAccess,
                          [id]: e.target.checked,
                        })
                      }
                      className="mt-1 h-5 w-5 cursor-pointer accent-[var(--accent-quiet)]"
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-[var(--black)]">{label}</p>
                      <p className="mt-1 text-sm text-[var(--gray-dark)]">{description}</p>
                    </div>
                  </label>
                ))}
              </div>

              <button
                type="button"
                disabled={isBusy}
                onClick={async () => {
                  const success = await runAction(saveCapabilities);
                  if (success) {
                    setCompletedSteps([...completedSteps, 3]);
                    setStep(4);
                  }
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--accent)] bg-[var(--accent-strong)] px-4 font-bold uppercase tracking-[0.1em] text-[var(--accent-ink)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Save & Complete Setup'}
              </button>
            </div>
          )}
        </section>

        {/* Complete State */}
        {step === 4 && (
          <section className="rounded-2xl border-2 border-[var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_8%,white)] p-6 text-center">
            <p className="text-4xl">🎉</p>
            <h2 className="mt-4 font-display text-2xl font-black">You&apos;re All Set!</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--gray-dark)]">
              Your gym profile is ready. You can now invite coaches and athletes to join. Sign out and log in with your new account to get started.
            </p>
            <div className="mt-6 space-x-3 flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setGymId('');
                  setGymName('');
                  setAdminAccountId('');
                  setAdminPin('');
                  setAdminConfirmPin('');
                  setGymCapabilityAccess({});
                  setCompletedSteps([]);
                }}
                className="inline-flex h-11 items-center rounded-lg border-2 border-[var(--gray-dark)] bg-white px-6 font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
              >
                Start Over
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
