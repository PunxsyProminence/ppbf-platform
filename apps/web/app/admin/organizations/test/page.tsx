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
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-3xl space-y-[var(--s5)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Setup Wizard</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Test Wizard Disabled</h1>
            <p className="t-body mt-[var(--s3)]">
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
    <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-3xl space-y-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        {/* Test Banner */}
        <div className="mat-leather--raised flex flex-wrap items-center gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:var(--restricted)] p-[var(--s4)]">
          <span className="badge badge--restricted"><i>▲</i>Test Mode</span>
          <p className="t-body">No authentication required. Form submissions are simulated.</p>
        </div>

        {/* Header */}
        <header className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather space-y-[var(--s4)] p-[var(--s5)]">
            <p className="t-eyebrow">Setup Wizard</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Get Your Gym Online</h1>
            <p className="t-body">
              Follow these 3 simple steps to set up your gym in PPBF and start managing athletes.
            </p>
          </div>
        </header>

        {/* Progress Indicator */}
        <div className="flex items-center justify-between gap-[var(--s2)]">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex flex-1 items-center gap-[var(--s2)]">
              <div
                className={`flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 font-bold transition ${
                  s < step
                    ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                    : s === step
                      ? 'border-[color:var(--brass-400)] bg-[var(--hide-900)] text-[color:var(--brass-300)]'
                      : 'border-[color:var(--hide-600)] bg-[var(--hide-900)] text-[color:var(--bone-400)]'
                }`}
              >
                {s < step ? '✓' : s}
              </div>
              {s < 3 && <div className={`h-[3px] flex-1 rounded-[var(--r-sm)] ${s < step ? 'bg-[var(--brass-700)]' : 'bg-[var(--hide-700)]'}`} />}
            </div>
          ))}
        </div>

        {/* Feedback Message */}
        {feedback && (
          <div
            className={`rounded-[var(--r-md)] border px-[var(--s4)] py-[var(--s3)] ${
              feedback.kind === 'error'
                ? 'border-[color:var(--brass-700)] bg-[var(--rust-900)]'
                : feedback.kind === 'success'
                  ? 'border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_16%,var(--hide-950))]'
                  : 'mat-leather--raised border-[color:var(--hide-600)]'
            }`}
          >
            <p
              className={`text-[length:var(--t-sm)] font-semibold ${
                feedback.kind === 'error'
                  ? 'text-[color:var(--locked-ink)]'
                  : feedback.kind === 'success'
                    ? 'text-[color:var(--cleared-ink)]'
                    : 'text-[color:var(--bone-300)]'
              }`}
            >
              {feedback.kind === 'error' && '✕ '}{feedback.kind === 'success' && '✓ '}{feedback.text}
            </p>
          </div>
        )}

        {/* Step 1: Create Gym */}
        <section
          className={`mat-leather rounded-[var(--r-lg)] border p-[var(--s5)] transition ${
            step === 1
              ? 'border-[color:var(--brass-400)]'
              : 'border-[color:var(--hide-700)] opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-[var(--s4)]">
            <div className="flex-1">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 1: Create Your Gym Profile</h2>
              <p className="t-body mt-[var(--s3)]">
                Give your gym a unique ID and friendly name. This is how PPBF identifies your organization.
              </p>
            </div>
            {step1Complete && <span className="badge badge--cleared"><i>✓</i>Done</span>}
          </div>

          {step === 1 && (
            <div className="mt-[var(--s5)] space-y-[var(--s4)]">
              <div className="field">
                <label className="t-label">Gym ID (Short Code)</label>
                <p className="t-muted mb-[var(--s2)]">Use lowercase letters and numbers, no spaces. Example: &quot;golden_boxing&quot;</p>
                <input
                  type="text"
                  value={gymId}
                  onChange={(e) => setGymId(e.target.value.toLowerCase())}
                  placeholder="golden_boxing"
                  className="input font-mono"
                />
              </div>

              <div className="field">
                <label className="t-label">Gym Name (Display Name)</label>
                <p className="t-muted mb-[var(--s2)]">The full name of your gym as you&apos;d like it to appear.</p>
                <input
                  type="text"
                  value={gymName}
                  onChange={(e) => setGymName(e.target.value)}
                  placeholder="Golden Boxing Studio"
                  className="input"
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
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Gym & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Create Admin Account */}
        <section
          className={`mat-leather rounded-[var(--r-lg)] border p-[var(--s5)] transition ${
            step === 2
              ? 'border-[color:var(--brass-400)]'
              : 'border-[color:var(--hide-700)] opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-[var(--s4)]">
            <div className="flex-1">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 2: Create Your Admin Account</h2>
              <p className="t-body mt-[var(--s3)]">
                This will be your first user account. You&apos;ll use the Account ID and PIN to sign in to PPBF.
              </p>
            </div>
            {step2Complete && <span className="badge badge--cleared"><i>✓</i>Done</span>}
          </div>

          {step === 2 && (
            <div className="mt-[var(--s5)] space-y-[var(--s4)]">
              <div className="field">
                <label className="t-label">Your Account ID</label>
                <p className="t-muted mb-[var(--s2)]">A unique identifier for you. Example: &quot;coach-john&quot; or &quot;admin-001&quot;</p>
                <input
                  type="text"
                  value={adminAccountId}
                  onChange={(e) => setAdminAccountId(e.target.value)}
                  placeholder="coach-john"
                  className="input font-mono"
                />
              </div>

              <div className="field">
                <label className="t-label">PIN (4+ digits)</label>
                <p className="t-muted mb-[var(--s2)]">A secure PIN code you&apos;ll use to sign in. Example: 1234 or 9876</p>
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => setAdminPin(e.target.value)}
                  placeholder="••••"
                  className="input"
                />
              </div>

              <div className="field">
                <label className="t-label">Confirm PIN</label>
                <input
                  type="password"
                  value={adminConfirmPin}
                  onChange={(e) => setAdminConfirmPin(e.target.value)}
                  placeholder="••••"
                  className="input"
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
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Admin Account & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 3: Configure Features */}
        <section
          className={`mat-leather rounded-[var(--r-lg)] border p-[var(--s5)] transition ${
            step === 3 ? 'border-[color:var(--brass-400)]' : 'border-[color:var(--hide-700)] opacity-60'
          }`}
        >
          <div className="flex-1">
            <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 3: Choose Your Features</h2>
            <p className="t-body mt-[var(--s3)]">
              Select which tools your gym wants to use. You can always change these later.
            </p>
          </div>

          {step === 3 && (
            <div className="mt-[var(--s5)] space-y-[var(--s4)]">
              <div className="space-y-[var(--s3)]">
                {gymCapabilities.map(({ id, label, description }) => (
                  <label key={id} className="mat-leather--raised flex cursor-pointer items-start gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:var(--hide-700)] p-[var(--s4)] transition hover:border-[color:var(--brass-700)]">
                    <input
                      type="checkbox"
                      checked={gymCapabilityAccess[id] ?? false}
                      onChange={(e) =>
                        setGymCapabilityAccess({
                          ...gymCapabilityAccess,
                          [id]: e.target.checked,
                        })
                      }
                      className="mt-1 h-5 w-5 cursor-pointer accent-[var(--brass-500)]"
                    />
                    <div className="flex-1">
                      <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{label}</p>
                      <p className="t-muted mt-[var(--s1)]">{description}</p>
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
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Save & Complete Setup'}
              </button>
            </div>
          )}
        </section>

        {/* Complete State */}
        {step === 4 && (
          <section className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:var(--cleared)] p-[var(--s5)] text-center">
            <span className="stamp stamp--green stamp--lg">Complete</span>
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>You&apos;re All Set!</h2>
            <p className="t-body">
              Your gym profile is ready. You can now invite coaches and athletes to join. Sign out and log in with your new account to get started.
            </p>
            <div className="flex justify-center gap-[var(--s3)]">
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
                className="btn btn--ghost"
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
