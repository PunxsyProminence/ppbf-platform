'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';


type FeedbackKind = 'success' | 'error' | 'info';

const gymCapabilities = [
  { id: 'attendance', label: 'Check-in & Check-out', description: 'Track who is at the gym and when they arrive/leave.' },
  { id: 'coach-notes', label: 'Coach Notes', description: 'Let coaches write and save private notes about athlete progress.' },
  { id: 'progression', label: 'Progress Tracking', description: 'Show gym admins a summary of how athletes are improving.' },
  { id: 'announcements', label: 'Gym Announcements', description: 'Post messages to all gym members (schedule changes, events, etc.).' },
  { id: 'sparring', label: 'Sparring & Safety Tools', description: 'Track and manage sparring sessions with safety guidelines.' },
  { id: 'publication', label: 'Content Publishing', description: 'Allow coaches to share videos, photos, and updates.' },
];

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${path}`);
  }
}

export default function SetupWizard() {
  const [step, setStep] = useState(1);
  const [isMicrosoftSession, setIsMicrosoftSession] = useState(false);
  const [sessionRole, setSessionRole] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

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

  // Auth check
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/auth/session', {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          setAuthChecked(true);
          return;
        }

        const data = (await response.json()) as { authProvider?: string; auth_provider?: string; role?: string };
        // Check if authenticated via Microsoft
        const authProvider = data.auth_provider ?? data.authProvider;
        const isMicrosoft = authProvider === 'microsoft';
        setIsMicrosoftSession(isMicrosoft);
        setSessionRole(data.role ?? null);
      } catch {
        // Fall through
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  // Load gym capabilities
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/admin/gym-capabilities', {
          method: 'GET',
          credentials: 'include',
        });

        if (!response.ok) return;

        const data = (await response.json()) as { capabilityAccess?: Record<string, boolean> };
        setGymCapabilityAccess(data.capabilityAccess || {});
      } catch {
        // Ignore
      }
    })();
  }, []);

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
    await postJson('/api/pilot/platform/organizations', {
      organization_id: gymId.trim(),
      organization_name: gymName.trim(),
    });
    return `Gym "${gymName}" created successfully!`;
  }

  async function createAdminAccount() {
    if (!adminAccountId.trim()) throw new Error('Please enter an Admin Account ID');
    if (!adminPin.trim()) throw new Error('Please enter a PIN code');
    if (adminPin !== adminConfirmPin) throw new Error('PINs do not match');
    if (adminPin.length < 4) throw new Error('PIN must be at least 4 characters');

    await postJson('/api/pilot/platform/users/create', {
      organization_id: gymId.trim(),
      account_id: adminAccountId.trim(),
      role: 'organization_admin',
      pin: adminPin,
    });
    return `Admin account "${adminAccountId}" created successfully!`;
  }

  async function saveCapabilities() {
    const capabilityAccess = Object.fromEntries(
      Object.entries(gymCapabilityAccess).filter(([, enabled]) => Boolean(enabled)),
    );
    const enabledCapabilities = Object.keys(capabilityAccess);

    if (enabledCapabilities.length === 0) {
      throw new Error('Please select at least one feature for your gym');
    }

    // Call backend to persist capability settings
    await postJson('/api/pilot/admin/gym-capabilities', {
      capabilityAccess,
    });

    return `Saved ${enabledCapabilities.length} feature${enabledCapabilities.length === 1 ? '' : 's'} for your gym`;
  }

  const hasPlatformAccess = isMicrosoftSession && sessionRole === 'platform_owner';

  if (!authChecked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Checking Access</p>
          <h1 className="mt-3 font-display text-2xl tracking-tight">Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="mx-auto max-w-2xl space-y-6 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Access Denied</p>
          <h1 className="font-display text-3xl font-black">Platform Owner Access Required</h1>
          <p className="text-sm leading-7 text-[var(--gray-dark)]">
            This setup wizard is for PPBF platform administrators only. To proceed:
          </p>
          <ol className="text-left max-w-xl mx-auto space-y-2 text-sm text-[var(--gray-dark)]">
            <li><strong>1. Sign in with your Microsoft account</strong> (Office 365, Outlook, etc.)</li>
            <li><strong>2. Verify your platform_owner role</strong> is active in PPBF</li>
            <li><strong>3. Return to this page</strong> to create a new gym</li>
          </ol>
          <p className="text-xs italic text-[var(--gray-dark)]">If you&apos;re a gym owner (not a platform administrator), contact your PPBF platform administrator for gym setup assistance.</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-[var(--red-highlight)]">
              Sign In With Microsoft
            </Link>
            <Link href="/admin" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
              Go To Admin Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const canStep1 = gymId.trim() && gymName.trim();
  const canStep2 = adminAccountId.trim() && adminPin.trim() && adminPin === adminConfirmPin && adminPin.length >= 4;
  const step1Complete = completedSteps.includes(1);
  const step2Complete = completedSteps.includes(2);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12 lg:px-10">
        {/* Header */}
        <header className="space-y-4 rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Setup Wizard</p>
          <h1 className="font-display text-4xl font-black">Get Your Gym Online</h1>
          <p className="text-base leading-7 text-[var(--gray-dark)]">
            Follow these 3 simple steps to set up your gym in PPBF and start managing athletes.
          </p>
          <div className="pt-2">
            <Link
              href="/login?logout=true"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border-2 border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
            >
              Sign Out Current Session
            </Link>
          </div>
        </header>

        {/* Progress Indicator */}
        <div className="flex items-center justify-between gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 font-bold transition ${
                  s < step
                    ? 'border-[var(--red-primary)] bg-[var(--red-primary)] text-white'
                    : s === step
                      ? 'border-[var(--red-primary)] bg-white text-[var(--red-primary)]'
                      : 'border-[rgba(0,0,0,0.14)] bg-white text-[var(--gray-dark)]'
                }`}
              >
                {s < step ? '✓' : s}
              </div>
              {s < 3 && <div className={`flex-1 h-1 rounded ${s < step ? 'bg-[var(--red-primary)]' : 'bg-[rgba(0,0,0,0.08)]'}`} />}
            </div>
          ))}
        </div>

        {/* Feedback Message */}
        {feedback && (
          <div
            className={`rounded-xl border px-4 py-3 ${
              feedback.kind === 'error'
                ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)]'
                : feedback.kind === 'success'
                  ? 'border-[#4caf50] bg-[rgba(76,175,80,0.05)]'
                  : 'border-[var(--gray-medium)] bg-[rgba(0,0,0,0.03)]'
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                feedback.kind === 'error'
                  ? 'text-[var(--red-primary)]'
                  : feedback.kind === 'success'
                    ? 'text-[#2e7d32]'
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
              ? 'border-[var(--red-primary)] bg-white shadow-[0_4px_12px_rgba(184,59,52,0.15)]'
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
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
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
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                />
              </div>

              <button
                type="button"
                disabled={!canStep1 || isBusy}
                onClick={() => {
                  void runAction(createGym).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 1]);
                      setStep(2);
                    }
                  });
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Gym &amp; Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Create Admin Account */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 2
              ? 'border-[var(--red-primary)] bg-white shadow-[0_4px_12px_rgba(184,59,52,0.15)]'
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
              <div className="rounded-lg border border-[rgba(184,59,52,0.2)] bg-[rgba(184,59,52,0.05)] p-4">
                <p className="text-xs font-semibold text-[var(--red-primary)] uppercase tracking-[0.1em]">⚠️ Important Setup Note</p>
                <p className="mt-2 text-sm text-[var(--gray-dark)]">The account created here becomes an <strong>Organization Admin</strong> with PIN-based sign-in. This is separate from your platform_owner Microsoft account (used above). Organization admins manage their gym&apos;s day-to-day operations.</p>
                <p className="mt-2 text-sm text-[var(--gray-dark)]"><strong>Your PIN is only set when you click</strong> Create Admin Account &amp; Continue.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Organization Admin Account ID</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">A unique identifier for the organization admin. Example: &quot;coach-john&quot; or &quot;admin-001&quot;</p>
                <input
                  type="text"
                  value={adminAccountId}
                  onChange={(e) => setAdminAccountId(e.target.value)}
                  placeholder="coach-john"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">PIN (4+ digits)</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">A secure PIN code for sign-in. Avoid predictable patterns (1234, 5678). Example: 5832 or 2947</p>
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => setAdminPin(e.target.value)}
                  placeholder="••••"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Confirm PIN</label>
                <input
                  type="password"
                  value={adminConfirmPin}
                  onChange={(e) => setAdminConfirmPin(e.target.value)}
                  placeholder="••••"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
                />
              </div>

              <button
                type="button"
                disabled={!canStep2 || isBusy}
                onClick={() => {
                  void runAction(createAdminAccount).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 2]);
                      setStep(3);
                    }
                  });
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Admin Account & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 3: Configure Features */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 3 ? 'border-[var(--red-primary)] bg-white shadow-[0_4px_12px_rgba(184,59,52,0.15)]' : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
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
                  <label key={id} className="flex items-start gap-3 rounded-lg border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] p-4 cursor-pointer hover:border-[var(--red-primary)] transition">
                    <input
                      type="checkbox"
                      checked={gymCapabilityAccess[id] ?? false}
                      onChange={(e) =>
                        setGymCapabilityAccess({
                          ...gymCapabilityAccess,
                          [id]: e.target.checked,
                        })
                      }
                      className="mt-1 h-5 w-5 cursor-pointer accent-[var(--red-primary)]"
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
                onClick={() => {
                  void runAction(saveCapabilities).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 3]);
                      setStep(4); // "Complete" state
                    }
                  });
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Save & Complete Setup'}
              </button>
            </div>
          )}
        </section>

        {/* Complete State */}
        {step === 4 && (
          <section className="rounded-2xl border-2 border-[#4caf50] bg-[rgba(76,175,80,0.05)] p-6 space-y-6">
            <div className="text-center">
              <p className="text-4xl">🎉</p>
              <h2 className="mt-4 font-display text-2xl font-black">Gym Setup Complete!</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--gray-dark)]">
                Your gym is now configured and ready for coaches and athletes to join.
              </p>
            </div>

            <div className="space-y-3 rounded-lg bg-white p-4 border border-[rgba(0,0,0,0.12)]">
              <p className="text-sm font-semibold text-[var(--black)]">Next Steps:</p>
              <ol className="space-y-2 text-sm text-[var(--gray-dark)]">
                <li><strong>1. Sign out</strong> from your platform_owner account</li>
                <li><strong>2. Sign in with PIN:</strong> Use account ID <strong>{adminAccountId || 'the one you created in Step 2'}</strong> and the PIN from Step 2</li>
                <li><strong>3. Create team accounts:</strong> Set up coach and athlete accounts from the admin dashboard</li>
                <li><strong>4. Manage features:</strong> Access the capabilities you selected (check-in, notes, announcements, etc.)</li>
              </ol>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login?logout=true"
                className="flex-1 inline-flex h-11 items-center justify-center rounded-lg border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)]"
              >
                Sign Out &amp; Go To PIN Login
              </Link>
              <Link
                href="/admin"
                className="flex-1 inline-flex h-11 items-center justify-center rounded-lg border-2 border-[rgba(0,0,0,0.14)] bg-white px-6 font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
              >
                Admin Dashboard
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
