'use client';

import { useState } from 'react';
import Link from 'next/link';

import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';


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
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    credentials: 'include',
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
  const session = usePilotSession();
  const isMicrosoftSession = session.authProvider === 'microsoft';
  const sessionRole = session.role;
  const authChecked = !session.loading;

  // Step 1: Create Gym
  const [gymId, setGymId] = useState('');
  const [gymName, setGymName] = useState('');

  // Step 2: Provision the gym's first organization admin
  const [adminEmail, setAdminEmail] = useState('');

  // Step 3: Configure Features. Starts empty on purpose -- this is the new
  // gym's feature set, not the signed-in platform owner's own organization.
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
    await postJson('/api/pilot/platform/organizations', {
      organization_id: gymId.trim(),
      organization_name: gymName.trim(),
    });
    return `Gym "${gymName}" created successfully!`;
  }

  async function createOrganizationAdmin() {
    const email = adminEmail.trim();
    if (!email) {
      throw new Error('Please enter the Microsoft email address for this gym’s admin');
    }

    // Maps the email onto the organization_admin role. This is what makes
    // their Microsoft sign-in resolve to a PPBF session -- without it there is
    // no way for anyone but the platform owner to sign in to this gym.
    await postJson('/api/pilot/platform/staff', {
      organization_id: gymId.trim(),
      login_email: email,
      role: 'organization_admin',
    });

    return `${email} is now the gym admin. If they are outside your Microsoft tenant, invite them as an Entra guest before they try to sign in.`;
  }

  async function saveCapabilities() {
    // Only the ids this wizard offers, so nothing outside the checkbox list can
    // ride along into the new gym's capability set.
    const capabilityAccess = Object.fromEntries(
      gymCapabilities.map(({ id }) => [id, gymCapabilityAccess[id] === true]),
    );
    const enabledCount = Object.values(capabilityAccess).filter(Boolean).length;

    if (enabledCount === 0) {
      throw new Error('Please select at least one feature for your gym');
    }

    // Call backend to persist capability settings. organization_id targets the
    // gym just created in step 1 -- without it (and without capabilityAccess
    // matching the route's actual field name/shape) this silently saved an
    // empty capability set to the platform owner's own organization instead.
    await postJson('/api/pilot/admin/gym-capabilities', {
      organization_id: gymId.trim(),
      capabilityAccess,
    });

    return `Saved ${enabledCount} feature${enabledCount === 1 ? '' : 's'} for your gym`;
  }

  const hasPlatformAccess = isMicrosoftSession && sessionRole === 'platform_owner';

  if (!authChecked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Checking Access</p>
          <h1 className="mt-3 font-display text-2xl tracking-tight">Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="mx-auto max-w-2xl space-y-6 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Access Denied</p>
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
            <Link href="/login" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--safety-locked)] px-6 text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-[var(--red-highlight)]">
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
  const canStep2 = adminEmail.trim().length > 0;
  const step1Complete = completedSteps.includes(1);
  const step2Complete = completedSteps.includes(2);

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12 lg:px-10">
        {/* Header */}
        <header className="space-y-4 rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--safety-locked)]">Setup Wizard</p>
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
                    ? 'border-[var(--safety-locked)] bg-[var(--safety-locked)] text-white'
                    : s === step
                      ? 'border-[var(--safety-locked)] bg-white text-[var(--safety-locked)]'
                      : 'border-[rgba(0,0,0,0.14)] bg-white text-[var(--gray-dark)]'
                }`}
              >
                {s < step ? '✓' : s}
              </div>
              {s < 3 && <div className={`flex-1 h-1 rounded ${s < step ? 'bg-[var(--safety-locked)]' : 'bg-[rgba(0,0,0,0.08)]'}`} />}
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
                  ? 'border-[#4caf50] bg-[rgba(76,175,80,0.05)]'
                  : 'border-[var(--gray-medium)] bg-[rgba(0,0,0,0.03)]'
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                feedback.kind === 'error'
                  ? 'text-[var(--safety-locked)]'
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
              ? 'border-[var(--safety-locked)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--safety-locked)_15%,white)]'
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
                onClick={() => {
                  void runAction(createGym).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 1]);
                      setStep(2);
                    }
                  });
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--safety-locked)] bg-[var(--safety-locked)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Gym & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Microsoft-Authenticated Admin Path */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 2
              ? 'border-[var(--safety-locked)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--safety-locked)_15%,white)]'
              : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-lg font-bold">Step 2: Add The Gym Admin</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Every gym needs one person who can manage it. They sign in with Microsoft — PINs are athlete-only.
              </p>
            </div>
            {step2Complete && <span className="text-2xl">✓</span>}
          </div>

          {step === 2 && (
            <div className="mt-6 space-y-4">
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--safety-locked)_20%,white)] bg-[color-mix(in_srgb,var(--safety-locked)_5%,white)] p-4">
                <p className="text-xs font-semibold text-[var(--safety-locked)] uppercase tracking-[0.1em]">This is two steps, not one</p>
                <p className="mt-2 text-sm text-[var(--gray-dark)]">
                  Saving here gives this person the gym admin role in PPBF. If their email is outside your Microsoft
                  tenant, you also have to invite them as a guest in Entra ID — sign-in is rejected until both are done.
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-[var(--black)]">Gym Admin Microsoft Email</label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">The exact address they will sign in with.</p>
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="owner@goldenboxing.org"
                  className="mt-2 h-11 w-full rounded-lg border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>

              <button
                type="button"
                disabled={!canStep2 || isBusy}
                onClick={() => {
                  void runAction(createOrganizationAdmin).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 2]);
                      setStep(3);
                    }
                  });
                }}
                className="h-11 w-full rounded-lg border-2 border-[var(--safety-locked)] bg-[var(--safety-locked)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Add Gym Admin & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 3: Configure Features */}
        <section
          className={`rounded-2xl border-2 p-6 transition ${
            step === 3 ? 'border-[var(--safety-locked)] bg-white shadow-[0_4px_12px_color-mix(in_srgb,var(--safety-locked)_15%,white)]' : 'border-[rgba(0,0,0,0.14)] bg-white/60 opacity-60'
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
                  <label key={id} className="flex items-start gap-3 rounded-lg border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] p-4 cursor-pointer hover:border-[var(--safety-locked)] transition">
                    <input
                      type="checkbox"
                      checked={gymCapabilityAccess[id] ?? false}
                      onChange={(e) =>
                        setGymCapabilityAccess({
                          ...gymCapabilityAccess,
                          [id]: e.target.checked,
                        })
                      }
                      className="mt-1 h-5 w-5 cursor-pointer accent-[var(--safety-locked)]"
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
                className="h-11 w-full rounded-lg border-2 border-[var(--safety-locked)] bg-[var(--safety-locked)] px-4 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
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
                <li><strong>1. Invite the gym admin as an Entra guest</strong> if their email is outside your Microsoft tenant — they cannot sign in until you do</li>
                <li><strong>2. Have them sign in with Microsoft</strong> and open People to add their coaches</li>
                <li><strong>3. They add athletes in People</strong> and hand out each athlete&apos;s sign-in ID plus the starting PIN</li>
                <li><strong>4. Athletes choose their own PIN</strong> the first time they sign in</li>
              </ol>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/admin/people"
                className="flex-1 inline-flex h-11 items-center justify-center rounded-lg border-2 border-[var(--safety-locked)] bg-[var(--safety-locked)] px-6 font-bold uppercase tracking-[0.1em] text-white transition hover:bg-[var(--red-highlight)]"
              >
                Manage People
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
