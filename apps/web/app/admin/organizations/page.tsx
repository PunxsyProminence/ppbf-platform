'use client';

import { useState } from 'react';
import Link from 'next/link';

import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { useFocusOnStepChange } from '@/src/lib/useFocusOnStepChange';


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
  // Each step transition unmounts the clicked button's whole content block
  // with no focus moved to the next step -- this is the fix.
  useFocusOnStepChange(`step-${step}-heading`);
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
      <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="text-center">
          <p className="t-eyebrow">Checking Access</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-lg)' }}>Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-2xl space-y-[var(--s5)] text-center">
          <p className="t-eyebrow">Access Denied</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Platform Owner Access Required</h1>
          <p className="t-body">
            This setup wizard is for PPBF platform administrators only. To proceed:
          </p>
          <ol className="t-body mx-auto max-w-xl space-y-[var(--s2)] text-left">
            <li><strong>1. Sign in with your Microsoft account</strong> (Office 365, Outlook, etc.)</li>
            <li><strong>2. Verify your platform_owner role</strong> is active in PPBF</li>
            <li><strong>3. Return to this page</strong> to create a new gym</li>
          </ol>
          <p className="t-muted italic">If you&apos;re a gym owner (not a platform administrator), contact your PPBF platform administrator for gym setup assistance.</p>
          <div className="flex flex-wrap items-center justify-center gap-[var(--s3)]">
            <Link href="/login" className="btn">
              Sign In With Microsoft
            </Link>
            <Link href="/admin" className="btn btn--ghost">
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
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-3xl space-y-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
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
              <h2 id="step-1-heading" tabIndex={-1} className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 1: Create Your Gym Profile</h2>
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
                onClick={() => {
                  void runAction(createGym).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 1]);
                      setStep(2);
                    }
                  });
                }}
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Creating...' : 'Create Gym & Continue'}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Microsoft-Authenticated Admin Path */}
        <section
          className={`mat-leather rounded-[var(--r-lg)] border p-[var(--s5)] transition ${
            step === 2
              ? 'border-[color:var(--brass-400)]'
              : 'border-[color:var(--hide-700)] opacity-60'
          }`}
        >
          <div className="flex items-start justify-between gap-[var(--s4)]">
            <div className="flex-1">
              <h2 id="step-2-heading" tabIndex={-1} className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 2: Add The Gym Admin</h2>
              <p className="t-body mt-[var(--s3)]">
                Every gym needs one person who can manage it. They sign in with Microsoft — PINs are athlete-only.
              </p>
            </div>
            {step2Complete && <span className="badge badge--cleared"><i>✓</i>Done</span>}
          </div>

          {step === 2 && (
            <div className="mt-[var(--s5)] space-y-[var(--s4)]">
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-eyebrow">This is two steps, not one</p>
                <p className="t-body mt-[var(--s2)]">
                  Saving here gives this person the gym admin role in PPBF. If their email is outside your Microsoft
                  tenant, you also have to invite them as a guest in Entra ID — sign-in is rejected until both are done.
                </p>
              </div>
              <div className="field">
                <label className="t-label">Gym Admin Microsoft Email</label>
                <p className="t-muted mb-[var(--s2)]">The exact address they will sign in with.</p>
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="owner@goldenboxing.org"
                  className="input"
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
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Add Gym Admin & Continue'}
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
            <h2 id="step-3-heading" tabIndex={-1} className="t-command" style={{ fontSize: 'var(--t-md)' }}>Step 3: Choose Your Features</h2>
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
                onClick={() => {
                  void runAction(saveCapabilities).then((success) => {
                    if (success) {
                      setCompletedSteps([...completedSteps, 3]);
                      setStep(4); // "Complete" state
                    }
                  });
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
          <section className="mat-leather space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:var(--cleared)] p-[var(--s5)]">
            <div className="space-y-[var(--s4)] text-center">
              <span className="stamp stamp--green stamp--lg">Setup Complete</span>
              <h2 id="step-4-heading" tabIndex={-1} className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Gym Setup Complete!</h2>
              <p className="t-body">
                Your gym is now configured and ready for coaches and athletes to join.
              </p>
            </div>

            <div className="mat-leather--raised space-y-[var(--s3)] rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-label">Next Steps:</p>
              <ol className="t-body space-y-[var(--s2)]">
                <li><strong>1. Invite the gym admin as an Entra guest</strong> if their email is outside your Microsoft tenant — they cannot sign in until you do</li>
                <li><strong>2. Have them sign in with Microsoft</strong> and open People to add their coaches</li>
                <li><strong>3. They add athletes in People</strong> and hand out each athlete&apos;s sign-in ID plus the starting PIN</li>
                <li><strong>4. Athletes choose their own PIN</strong> the first time they sign in</li>
              </ol>
            </div>

            <div className="flex flex-col gap-[var(--s3)] sm:flex-row">
              <Link href="/admin/people" className="btn flex-1">
                Manage People
              </Link>
              <Link href="/admin" className="btn btn--ghost flex-1">
                Admin Dashboard
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
