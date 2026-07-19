'use client';

import { useState } from 'react';
import Link from 'next/link';

type FeedbackKind = 'success' | 'error' | 'info';

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

  async function runAction(actionName: string, action: () => Promise<string>) {
    setActiveAction(actionName);
    setFeedback({ kind: 'info', text: `Running ${actionName}...` });
    try {
      const successMessage = await action();
      setFeedback({ kind: 'success', text: successMessage });
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : `${actionName} failed` });
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
    await postJson('/api/pilot/platform/users/create', {
      organization_id: createUserOrgId,
      account_id: createUserAccountId,
      role: createUserRole,
      pin: createUserPin,
      athlete_id: createUserRole === 'athlete' ? createUserAthleteId : undefined,
    });
    return `Created/updated ${createUserRole} account ${createUserAccountId} in ${createUserOrgId}`;
  }

  async function updateUserStatus() {
    const activeFlag = statusActiveFlag === 'active';
    await postJson('/api/pilot/platform/users/status', {
      organization_id: statusAccountOrgId,
      account_id: statusAccountId,
      active_flag: activeFlag,
    });
    return `${activeFlag ? 'Reactivated' : 'Disabled'} account ${statusAccountId} in ${statusAccountOrgId}`;
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

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8 lg:px-10">
        <header className="space-y-2 border-b-[3px] border-[var(--black)] pb-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Pilot Platform Controls</p>
          <h1 className="font-display text-4xl font-black">Organization Provisioning</h1>
          <p className="text-sm text-[var(--gray-dark)]">
            Live wiring for organization creation, status updates, and admin assignment.
          </p>
        </header>

        <section className="space-y-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Recommended Workflow</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Create organization.</li>
            <li>Create user account in that organization.</li>
            <li>Assign or transfer admin role.</li>
            <li>Use membership and status tools for lifecycle changes.</li>
          </ol>
          <p className="text-xs text-[var(--gray-dark)]">
            This control panel currently supports create/update/status operations. Hard delete is not exposed here.
          </p>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Create Organization</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="organization-id-input">Organization ID</label>
          <input
            id="organization-id-input"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="organization-name-input">Organization Name</label>
          <input
            id="organization-name-input"
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            placeholder="organization_name"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            disabled={!canCreateOrganization || isBusy}
            onClick={() => void runAction('Create Organization', createOrganization)}
            className="h-11 border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create Organization
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Update Organization Status</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="status-organization-id-input">Organization ID</label>
          <input
            id="status-organization-id-input"
            value={statusOrgId}
            onChange={(event) => setStatusOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="status-select">Status</label>
          <select
            id="status-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as 'active' | 'inactive' | 'suspended' | 'pending')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
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
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update Status
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Assign Organization Admin</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="assign-account-id-input">Account ID</label>
          <input
            id="assign-account-id-input"
            value={assignAccountId}
            onChange={(event) => setAssignAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="assign-organization-id-input">Organization ID</label>
          <input
            id="assign-organization-id-input"
            value={assignOrgId}
            onChange={(event) => setAssignOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            disabled={!canAssignAdmin || isBusy}
            onClick={() => void runAction('Assign Organization Admin', assignAdmin)}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Assign Admin
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Create User (PlatformOwner)</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="create-user-organization-id-input">Organization ID</label>
          <input
            id="create-user-organization-id-input"
            value={createUserOrgId}
            onChange={(event) => setCreateUserOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="create-user-account-id-input">Account ID</label>
          <input
            id="create-user-account-id-input"
            value={createUserAccountId}
            onChange={(event) => setCreateUserAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="create-user-role-select">Role</label>
          <select
            id="create-user-role-select"
            value={createUserRole}
            onChange={(event) => setCreateUserRole(event.target.value as 'organization_admin' | 'coach' | 'athlete' | 'parent')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="organization_admin">organization_admin</option>
            <option value="coach">coach</option>
            <option value="athlete">athlete</option>
            <option value="parent">parent</option>
          </select>
          {createUserRole === 'athlete' ? (
            <>
              <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="create-user-athlete-id-input">Athlete ID</label>
              <input
                id="create-user-athlete-id-input"
                value={createUserAthleteId}
                onChange={(event) => setCreateUserAthleteId(event.target.value)}
                placeholder="athlete_id (required for athlete role)"
                className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
              />
            </>
          ) : null}
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="create-user-pin-input">Initial PIN</label>
          <input
            id="create-user-pin-input"
            value={createUserPin}
            onChange={(event) => setCreateUserPin(event.target.value)}
            placeholder="initial PIN"
            type="password"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            disabled={!canCreateUser || isBusy}
            onClick={() => void runAction('Create User', createUser)}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create User
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Disable / Reactivate User</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="status-account-organization-id-input">Organization ID</label>
          <input
            id="status-account-organization-id-input"
            value={statusAccountOrgId}
            onChange={(event) => setStatusAccountOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="status-account-id-input">Account ID</label>
          <input
            id="status-account-id-input"
            value={statusAccountId}
            onChange={(event) => setStatusAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="status-active-flag-select">Status</label>
          <select
            id="status-active-flag-select"
            value={statusActiveFlag}
            onChange={(event) => setStatusActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            disabled={!canUpdateUserStatus || isBusy}
            onClick={() => void runAction('Update User Status', updateUserStatus)}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update User Status
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Transfer Organization Admin</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="transfer-organization-id-input">Organization ID</label>
          <input
            id="transfer-organization-id-input"
            value={transferOrgId}
            onChange={(event) => setTransferOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="transfer-from-account-id-input">From Account ID</label>
          <input
            id="transfer-from-account-id-input"
            value={transferFromAccountId}
            onChange={(event) => setTransferFromAccountId(event.target.value)}
            placeholder="from_account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="transfer-to-account-id-input">To Account ID</label>
          <input
            id="transfer-to-account-id-input"
            value={transferToAccountId}
            onChange={(event) => setTransferToAccountId(event.target.value)}
            placeholder="to_account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="transfer-demote-role-select">Demote Previous Admin To</label>
          <select
            id="transfer-demote-role-select"
            value={transferDemoteRole}
            onChange={(event) => setTransferDemoteRole(event.target.value as 'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff' | 'admin')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
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
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Transfer Admin
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Manage Organization Membership</h2>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="membership-organization-id-input">Organization ID</label>
          <input
            id="membership-organization-id-input"
            value={membershipOrgId}
            onChange={(event) => setMembershipOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="membership-account-id-input">Account ID</label>
          <input
            id="membership-account-id-input"
            value={membershipAccountId}
            onChange={(event) => setMembershipAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="membership-role-select">Role</label>
          <select
            id="membership-role-select"
            value={membershipRole}
            onChange={(event) => setMembershipRole(event.target.value as 'organization_admin' | 'admin' | 'coach' | 'athlete' | 'parent' | 'volunteer' | 'staff')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="organization_admin">organization_admin</option>
            <option value="admin">admin</option>
            <option value="coach">coach</option>
            <option value="athlete">athlete</option>
            <option value="parent">parent</option>
            <option value="volunteer">volunteer</option>
            <option value="staff">staff</option>
          </select>
          <label className="text-xs font-semibold uppercase tracking-[0.08em]" htmlFor="membership-status-select">Membership Status</label>
          <select
            id="membership-status-select"
            value={membershipActiveFlag}
            onChange={(event) => setMembershipActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            disabled={!canManageMembership || isBusy}
            onClick={() => void runAction('Update Membership', manageMembership)}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update Membership
          </button>
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
