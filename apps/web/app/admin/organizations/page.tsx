'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';

type FeedbackKind = 'success' | 'error' | 'info';

type CapabilityToggle = {
  id: string;
  label: string;
  description: string;
};

type OrganizationOption = {
  organization_id: string;
  organization_name: string;
  status: string;
};

const gymCapabilityCatalog: CapabilityToggle[] = [
  { id: 'attendance', label: 'Attendance Tracking', description: 'Enable check-in and check-out visibility for the gym.' },
  { id: 'coach-notes', label: 'Coach Notes', description: 'Allow coaches to record private notes and follow-ups.' },
  { id: 'progression', label: 'Progression Visibility', description: 'Show progression summaries to gym admins.' },
  { id: 'announcements', label: 'Gym Announcements', description: 'Publish gym-level announcements for members.' },
  { id: 'sparring', label: 'Sparring Review', description: 'Open sparring review and safety review tooling.' },
  { id: 'publication', label: 'Publication Controls', description: 'Toggle whether content can be published from the gym.' },
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

export default function AdminOrganizationsPage() {
  const [organizationId, setOrganizationId] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [statusOrgId, setStatusOrgId] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'suspended' | 'pending'>('active');
  const [assignAccountId, setAssignAccountId] = useState('');
  const [assignOrgId, setAssignOrgId] = useState('');
  const [createUserOrgId, setCreateUserOrgId] = useState('');
  const [createUserAccountId, setCreateUserAccountId] = useState('');
  const [createUserRole, setCreateUserRole] = useState<'organization_admin' | 'coach' | 'athlete' | 'parent'>('coach');
  const [createUserPin, setCreateUserPin] = useState('');
  const [createUserAthleteId, setCreateUserAthleteId] = useState('');
  const [statusAccountId, setStatusAccountId] = useState('');
  const [statusAccountOrgId, setStatusAccountOrgId] = useState('');
  const [statusActiveFlag, setStatusActiveFlag] = useState<'active' | 'inactive'>('active');
  const [transferOrgId, setTransferOrgId] = useState('');
  const [transferFromAccountId, setTransferFromAccountId] = useState('');
  const [transferToAccountId, setTransferToAccountId] = useState('');
  const [transferDemoteRole, setTransferDemoteRole] = useState<'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff' | 'admin'>('coach');
  const [membershipOrgId, setMembershipOrgId] = useState('');
  const [membershipAccountId, setMembershipAccountId] = useState('');
  const [membershipRole, setMembershipRole] = useState<'organization_admin' | 'admin' | 'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff'>('coach');
  const [membershipActiveFlag, setMembershipActiveFlag] = useState<'active' | 'inactive'>('active');
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; text: string } | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [organizationOptions, setOrganizationOptions] = useState<OrganizationOption[]>([]);
  const [isMicrosoftSession, setIsMicrosoftSession] = useState(false);
  const [sessionRole, setSessionRole] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [gymCapabilityAccess, setGymCapabilityAccess] = useState<Record<string, boolean>>({});
  const [gymCapabilityHydrated, setGymCapabilityHydrated] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/admin/gym-capabilities', {
          method: 'GET',
          credentials: 'include',
        });

        if (!response.ok) {
          setGymCapabilityHydrated(true);
          return;
        }

        const payload = (await response.json()) as { capabilityAccess?: Record<string, boolean> };
        setGymCapabilityAccess(payload.capabilityAccess || {});
      } catch {
        // Keep default switchboard state if backend load fails.
      } finally {
        setGymCapabilityHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!gymCapabilityHydrated) {
      return;
    }

    void fetch('/api/pilot/admin/gym-capabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ capabilityAccess: gymCapabilityAccess }),
    });
  }, [gymCapabilityAccess, gymCapabilityHydrated]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST' });
        if (!response.ok) {
          setAuthChecked(true);
          return;
        }

        const payload = (await response.json().catch(() => ({ authenticated: false }))) as {
          authenticated?: boolean;
          auth_provider?: string;
          role?: string;
        };

        setIsMicrosoftSession(payload.authenticated === true && payload.auth_provider === 'microsoft');
        setSessionRole(payload.authenticated ? payload.role || null : null);
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isMicrosoftSession) {
      return;
    }

    void (async () => {
      const response = await fetch(`${apiBase()}/api/pilot/platform/organizations`, { method: 'GET' });
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => ({ organizations: [] }))) as { organizations?: OrganizationOption[] };
      setOrganizationOptions(Array.isArray(payload.organizations) ? payload.organizations : []);
    })();
  }, [isMicrosoftSession]);

  let feedbackTextClass = 'text-[var(--gray-dark)]';
  if (feedback?.kind === 'error') {
    feedbackTextClass = 'text-[var(--red-primary)]';
  } else if (feedback?.kind === 'success') {
    feedbackTextClass = 'text-[var(--black)]';
  }

  const canCreateOrganization = organizationId.trim() && organizationName.trim();
  const canUpdateOrganizationStatus = statusOrgId.trim();
  const canAssignAdmin = assignAccountId.trim() && assignOrgId.trim();
  const canCreateUser = createUserOrgId.trim() && createUserAccountId.trim() && createUserPin.trim() && (createUserRole !== 'athlete' || createUserAthleteId.trim());
  const canUpdateUserStatus = statusAccountOrgId.trim() && statusAccountId.trim();
  const canTransferAdmin = transferOrgId.trim() && transferFromAccountId.trim() && transferToAccountId.trim();
  const canManageMembership = membershipOrgId.trim() && membershipAccountId.trim();
  const isBusy = activeAction !== null;
  const capabilitySummary = useMemo(
    () => gymCapabilityCatalog.map((capability) => ({ ...capability, enabled: !!gymCapabilityAccess[capability.id] })),
    [gymCapabilityAccess],
  );

  async function runAction(actionName: string, action: () => Promise<string>) {
    setActiveAction(actionName);
    setFeedback({ kind: 'info', text: `Running ${actionName}...` });
    try {
      const successMessage = await action();
      setFeedback({ kind: 'success', text: successMessage });
    } catch (error) {
      let errorMessage = `${actionName} failed`;
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      setFeedback({ kind: 'error', text: errorMessage });
    } finally {
      setActiveAction(null);
    }
  }

  async function createOrganization() {
    await postJson('/api/pilot/platform/organizations', {
      organization_id: organizationId,
      organization_name: organizationName,
    });
    return `Created organization ${organizationId}`;
  }

  async function updateOrganizationStatus() {
    await postJson('/api/pilot/platform/organizations/status', {
      organization_id: statusOrgId,
      status,
    });
    return `Set ${statusOrgId} status to ${status}`;
  }

  async function assignAdmin() {
    await postJson('/api/pilot/platform/organizations/assign-admin', {
      account_id: assignAccountId,
      organization_id: assignOrgId,
    });
    return `Assigned ${assignAccountId} as organization_admin in ${assignOrgId}`;
  }

  async function createUser() {
    const athleteId = createUserRole === 'athlete' ? createUserAthleteId : undefined;

    await postJson('/api/pilot/platform/users/create', {
      organization_id: createUserOrgId,
      account_id: createUserAccountId,
      role: createUserRole,
      pin: createUserPin,
      athlete_id: athleteId,
    });
    return `Created/updated ${createUserRole} account ${createUserAccountId} in ${createUserOrgId}`;
  }

  async function updateUserStatus() {
    const activeFlag = statusActiveFlag === 'active';
    const actionLabel = activeFlag ? 'Reactivated' : 'Disabled';

    await postJson('/api/pilot/platform/users/status', {
      organization_id: statusAccountOrgId,
      account_id: statusAccountId,
      active_flag: activeFlag,
    });
    return `${actionLabel} account ${statusAccountId} in ${statusAccountOrgId}`;
  }

  async function transferAdmin() {
    await postJson('/api/pilot/platform/organizations/transfer-admin', {
      organization_id: transferOrgId,
      from_account_id: transferFromAccountId,
      to_account_id: transferToAccountId,
      demote_role: transferDemoteRole,
    });
    return `Transferred admin from ${transferFromAccountId} to ${transferToAccountId} in ${transferOrgId}`;
  }

  async function manageMembership() {
    const activeFlag = membershipActiveFlag === 'active';
    await postJson('/api/pilot/platform/organizations/memberships', {
      organization_id: membershipOrgId,
      account_id: membershipAccountId,
      role: membershipRole,
      active_flag: activeFlag,
    });
    return `Updated membership for ${membershipAccountId} in ${membershipOrgId}`;
  }

  function toggleGymCapability(capabilityId: string) {
    setGymCapabilityAccess((current) => ({
      ...current,
      [capabilityId]: !current[capabilityId],
    }));
  }

  function renderFieldLabel(text: string, htmlFor: string) {
    return (
      <label className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--gray-dark)]" htmlFor={htmlFor}>
        {text}
      </label>
    );
  }

  if (!authChecked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Secure Session</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight">Checking access</h1>
        </div>
      </main>
    );
  }

  const hasPlatformAccess = isMicrosoftSession && sessionRole === 'platform_owner';

  if (!hasPlatformAccess) {
    return (
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-12 text-center lg:px-10">
          <h1 className="font-display text-4xl font-black">Platform Owner Access Required</h1>
          <p className="text-base leading-7 text-[var(--gray-dark)]">
            Organization Provisioning is limited to Microsoft-authenticated platform owner sessions.
          </p>
          {sessionRole === 'organization_admin' || sessionRole === 'admin' ? (
            <p className="text-sm leading-6 text-[var(--gray-dark)]">
              You are currently signed in as an organization admin. Use the admin workspace for gym operations.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)] transition hover:bg-[var(--red-highlight)]"
            >
              Sign In With Microsoft
            </Link>
            <Link
              href="/admin"
              className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]"
            >
              Go To Organization Admin
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8 lg:px-10">
        <header className="space-y-4 rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-[linear-gradient(135deg,var(--canvas-tan-light),#ffffff)] p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Pilot Platform Controls</p>
          <h1 className="font-display text-4xl font-black">Organization Provisioning</h1>
          <p className="text-sm text-[var(--gray-dark)]">
            Live wiring for organization creation, status updates, admin assignment, and gym capability access.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="#create-organization" className="rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-4 py-2 text-xs font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
              Create Org
            </a>
            <a href="#gym-capabilities" className="rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-4 py-2 text-xs font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
              Gym Capabilities
            </a>
            <a href="#membership-tools" className="rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-4 py-2 text-xs font-bold uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
              Membership Tools
            </a>
          </div>
        </header>

        <section className="rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-white/80 p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-lg font-bold">Recommended Workflow</h2>
          <ol className="mt-3 grid gap-2 text-sm md:grid-cols-2">
            <li><a href="#create-organization" className="font-semibold text-[var(--red-primary)] hover:underline">1. Create organization</a></li>
            <li><a href="#create-user" className="font-semibold text-[var(--red-primary)] hover:underline">2. Create user account</a></li>
            <li><a href="#assign-admin" className="font-semibold text-[var(--red-primary)] hover:underline">3. Assign or transfer admin role</a></li>
            <li><a href="#gym-capabilities" className="font-semibold text-[var(--red-primary)] hover:underline">4. Set gym capability access</a></li>
          </ol>
          <p className="mt-3 text-xs text-[var(--gray-dark)]">
            This control panel currently supports create/update/status operations. Hard delete is not exposed here.
          </p>
        </section>

        <details id="create-organization" open className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Create Organization</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Organization ID', 'organization-id-input')}
          <input
            id="organization-id-input"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Organization Name', 'organization-name-input')}
          <input
            id="organization-name-input"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            placeholder="organization_name"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          <button
            type="button"
            disabled={!canCreateOrganization || isBusy}
            onClick={() => void runAction('Create Organization', createOrganization)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)] transition hover:bg-[var(--red-highlight)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create Organization
          </button>
          </div>
        </details>

        <details className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Update Organization Status</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {organizationOptions.length > 0 ? renderFieldLabel('Select Organization', 'status-organization-id-select') : null}
          {organizationOptions.length > 0 ? (
            <select
              id="status-organization-id-select"
              value={statusOrgId}
              onChange={(event) => setStatusOrgId(event.target.value)}
              className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
            >
              <option value="">Choose organization</option>
              {organizationOptions.map((organization) => (
                <option key={organization.organization_id} value={organization.organization_id}>
                  {organization.organization_name} ({organization.organization_id})
                </option>
              ))}
            </select>
          ) : null}
          {renderFieldLabel('Organization ID', 'status-organization-id-input')}
          <input
            id="status-organization-id-input"
            value={statusOrgId}
            onChange={(event) => setStatusOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Status', 'status-select')}
          <select
            id="status-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as 'active' | 'inactive' | 'suspended' | 'pending')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
            <option value="suspended">suspended</option>
            <option value="pending">pending</option>
          </select>
          <button
            type="button"
            disabled={!canUpdateOrganizationStatus || isBusy}
            onClick={() => void runAction('Update Organization Status', updateOrganizationStatus)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update Status
          </button>
          </div>
        </details>

        <details id="assign-admin" className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Assign Organization Admin</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Account ID', 'assign-account-id-input')}
          <input
            id="assign-account-id-input"
            value={assignAccountId}
            onChange={(event) => setAssignAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Organization ID', 'assign-organization-id-input')}
          <input
            id="assign-organization-id-input"
            value={assignOrgId}
            onChange={(event) => setAssignOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          <button
            type="button"
            disabled={!canAssignAdmin || isBusy}
            onClick={() => void runAction('Assign Organization Admin', assignAdmin)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Assign Admin
          </button>
          </div>
        </details>

        <details id="create-user" className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Create User (PlatformOwner)</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Organization ID', 'create-user-organization-id-input')}
          <input
            id="create-user-organization-id-input"
            value={createUserOrgId}
            onChange={(event) => setCreateUserOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Account ID', 'create-user-account-id-input')}
          <input
            id="create-user-account-id-input"
            value={createUserAccountId}
            onChange={(event) => setCreateUserAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Role', 'create-user-role-select')}
          <select
            id="create-user-role-select"
            value={createUserRole}
            onChange={(event) => setCreateUserRole(event.target.value as 'organization_admin' | 'coach' | 'athlete' | 'parent')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="organization_admin">organization_admin</option>
            <option value="coach">coach</option>
            <option value="athlete">athlete</option>
            <option value="parent">parent</option>
          </select>
          {createUserRole === 'athlete' ? (
            <>
              {renderFieldLabel('Athlete ID', 'create-user-athlete-id-input')}
              <input
                id="create-user-athlete-id-input"
                value={createUserAthleteId}
                onChange={(event) => setCreateUserAthleteId(event.target.value)}
                placeholder="athlete_id (required for athlete role)"
                className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
              />
            </>
          ) : null}
          {renderFieldLabel('Initial PIN', 'create-user-pin-input')}
          <input
            id="create-user-pin-input"
            value={createUserPin}
            onChange={(event) => setCreateUserPin(event.target.value)}
            placeholder="initial PIN"
            type="password"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          <button
            type="button"
            disabled={!canCreateUser || isBusy}
            onClick={() => void runAction('Create User', createUser)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create User
          </button>
          </div>
        </details>

        <details className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Disable / Reactivate User</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Organization ID', 'status-account-organization-id-input')}
          <input
            id="status-account-organization-id-input"
            value={statusAccountOrgId}
            onChange={(event) => setStatusAccountOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Account ID', 'status-account-id-input')}
          <input
            id="status-account-id-input"
            value={statusAccountId}
            onChange={(event) => setStatusAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Status', 'status-active-flag-select')}
          <select
            id="status-active-flag-select"
            value={statusActiveFlag}
            onChange={(event) => setStatusActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            disabled={!canUpdateUserStatus || isBusy}
            onClick={() => void runAction('Update User Status', updateUserStatus)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update User Status
          </button>
          </div>
        </details>

        <details className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Transfer Organization Admin</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Organization ID', 'transfer-organization-id-input')}
          <input
            id="transfer-organization-id-input"
            value={transferOrgId}
            onChange={(event) => setTransferOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('From Account ID', 'transfer-from-account-id-input')}
          <input
            id="transfer-from-account-id-input"
            value={transferFromAccountId}
            onChange={(event) => setTransferFromAccountId(event.target.value)}
            placeholder="from_account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('To Account ID', 'transfer-to-account-id-input')}
          <input
            id="transfer-to-account-id-input"
            value={transferToAccountId}
            onChange={(event) => setTransferToAccountId(event.target.value)}
            placeholder="to_account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Demote Previous Admin To', 'transfer-demote-role-select')}
          <select
            id="transfer-demote-role-select"
            value={transferDemoteRole}
            onChange={(event) => setTransferDemoteRole(event.target.value as 'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff' | 'admin')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="coach">coach</option>
            <option value="athlete">athlete</option>
            <option value="parent">parent</option>
            <option value="volunteer">volunteer</option>
            <option value="staff">staff</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            disabled={!canTransferAdmin || isBusy}
            onClick={() => void runAction('Transfer Admin', transferAdmin)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Transfer Admin
          </button>
          </div>
        </details>

        <details id="membership-tools" className="overflow-hidden rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] shadow-[var(--shadow-sm)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-bold">Manage Organization Membership</summary>
          <div className="space-y-3 border-t border-[rgba(0,0,0,0.08)] p-5">
          {renderFieldLabel('Organization ID', 'membership-organization-id-input')}
          <input
            id="membership-organization-id-input"
            value={membershipOrgId}
            onChange={(event) => setMembershipOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Account ID', 'membership-account-id-input')}
          <input
            id="membership-account-id-input"
            value={membershipAccountId}
            onChange={(event) => setMembershipAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          />
          {renderFieldLabel('Role', 'membership-role-select')}
          <select
            id="membership-role-select"
            value={membershipRole}
            onChange={(event) => setMembershipRole(event.target.value as 'organization_admin' | 'admin' | 'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="organization_admin">organization_admin</option>
            <option value="admin">admin</option>
            <option value="coach">coach</option>
            <option value="athlete">athlete</option>
            <option value="parent">parent</option>
            <option value="volunteer">volunteer</option>
            <option value="staff">staff</option>
          </select>
          {renderFieldLabel('Membership Status', 'membership-status-select')}
          <select
            id="membership-status-select"
            value={membershipActiveFlag}
            onChange={(event) => setMembershipActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border border-[rgba(0,0,0,0.16)] bg-white px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            disabled={!canManageMembership || isBusy}
            onClick={() => void runAction('Update Membership', manageMembership)}
            className="h-11 rounded-full border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update Membership
          </button>
          </div>
        </details>

        <section id="gym-capabilities" className="rounded-[24px] border border-[rgba(0,0,0,0.14)] bg-[var(--canvas-tan-light)] p-5 shadow-[var(--shadow-sm)]">
          <h2 className="text-lg font-bold">Gym Admin Capability Toggles</h2>
          <p className="mt-2 text-sm text-[var(--gray-dark)]">
            Give a gym admin a capability, then flip it on or off for that organization.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {capabilitySummary.map((capability) => {
              const buttonLabel = capability.enabled ? 'Enabled for Gym Admin' : 'Disabled for Gym Admin';

              return (
                <article key={capability.id} className="rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white p-4 shadow-[var(--shadow-sm)]">
                  <p className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--red-primary)]">{capability.label}</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{capability.description}</p>
                  <button
                    type="button"
                    onClick={() => toggleGymCapability(capability.id)}
                    className={`mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full border px-4 text-xs font-black uppercase tracking-[0.12em] transition ${
                      capability.enabled
                        ? 'border-[rgba(184,59,52,0.35)] bg-[var(--red-primary)] text-[var(--white)] hover:bg-[var(--red-highlight)]'
                        : 'border-[rgba(0,0,0,0.12)] bg-white text-[var(--black)] hover:bg-[var(--canvas-tan)]'
                    }`}
                  >
                    {buttonLabel}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        {feedback ? (
          <p
            role="status"
            aria-live="polite"
             className={`text-sm font-semibold ${feedbackTextClass}`}
          >
            {feedback.text}
          </p>
        ) : null}

        <Link
          href="/admin"
          className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
        >
          Back to Admin Hub
        </Link>
      </div>
    </main>
  );
}
