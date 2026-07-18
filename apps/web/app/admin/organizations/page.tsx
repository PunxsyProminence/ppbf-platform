'use client';

import { useState } from 'react';
import Link from 'next/link';

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
  const [message, setMessage] = useState('');

  async function createOrganization() {
    await postJson('/api/pilot/platform/organizations', {
      organization_id: organizationId,
      organization_name: organizationName,
    });
    setMessage(`Created organization ${organizationId}`);
  }

  async function updateOrganizationStatus() {
    await postJson('/api/pilot/platform/organizations/status', {
      organization_id: statusOrgId,
      status,
    });
    setMessage(`Set ${statusOrgId} status to ${status}`);
  }

  async function assignAdmin() {
    await postJson('/api/pilot/platform/organizations/assign-admin', {
      account_id: assignAccountId,
      organization_id: assignOrgId,
    });
    setMessage(`Assigned ${assignAccountId} as organization_admin in ${assignOrgId}`);
  }

  async function createUser() {
    await postJson('/api/pilot/platform/users/create', {
      organization_id: createUserOrgId,
      account_id: createUserAccountId,
      role: createUserRole,
      pin: createUserPin,
      athlete_id: createUserRole === 'athlete' ? createUserAthleteId : undefined,
    });
    setMessage(`Created/updated ${createUserRole} account ${createUserAccountId} in ${createUserOrgId}`);
  }

  async function updateUserStatus() {
    const activeFlag = statusActiveFlag === 'active';
    await postJson('/api/pilot/platform/users/status', {
      organization_id: statusAccountOrgId,
      account_id: statusAccountId,
      active_flag: activeFlag,
    });
    setMessage(`${activeFlag ? 'Reactivated' : 'Disabled'} account ${statusAccountId} in ${statusAccountOrgId}`);
  }

  async function transferAdmin() {
    await postJson('/api/pilot/platform/organizations/transfer-admin', {
      organization_id: transferOrgId,
      from_account_id: transferFromAccountId,
      to_account_id: transferToAccountId,
      demote_role: transferDemoteRole,
    });
    setMessage(`Transferred admin from ${transferFromAccountId} to ${transferToAccountId} in ${transferOrgId}`);
  }

  async function manageMembership() {
    const activeFlag = membershipActiveFlag === 'active';
    await postJson('/api/pilot/platform/organizations/memberships', {
      organization_id: membershipOrgId,
      account_id: membershipAccountId,
      role: membershipRole,
      active_flag: activeFlag,
    });
    setMessage(`Updated membership for ${membershipAccountId} in ${membershipOrgId}`);
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

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Create Organization</h2>
          <input
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            placeholder="organization_name"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            onClick={() => void createOrganization().catch((error) => setMessage(error instanceof Error ? error.message : 'Create failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.12em] text-[var(--white)]"
          >
            Create Organization
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Update Organization Status</h2>
          <input
            value={statusOrgId}
            onChange={(event) => setStatusOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <select
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
            onClick={() => void updateOrganizationStatus().catch((error) => setMessage(error instanceof Error ? error.message : 'Status update failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Update Status
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Assign Organization Admin</h2>
          <input
            value={assignAccountId}
            onChange={(event) => setAssignAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={assignOrgId}
            onChange={(event) => setAssignOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            onClick={() => void assignAdmin().catch((error) => setMessage(error instanceof Error ? error.message : 'Assignment failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Assign Admin
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Create User (PlatformOwner)</h2>
          <input
            value={createUserOrgId}
            onChange={(event) => setCreateUserOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={createUserAccountId}
            onChange={(event) => setCreateUserAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <select
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
            <input
              value={createUserAthleteId}
              onChange={(event) => setCreateUserAthleteId(event.target.value)}
              placeholder="athlete_id (required for athlete role)"
              className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
            />
          ) : null}
          <input
            value={createUserPin}
            onChange={(event) => setCreateUserPin(event.target.value)}
            placeholder="initial PIN"
            type="password"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <button
            type="button"
            onClick={() => void createUser().catch((error) => setMessage(error instanceof Error ? error.message : 'Create user failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Create User
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Disable / Reactivate User</h2>
          <input
            value={statusAccountOrgId}
            onChange={(event) => setStatusAccountOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={statusAccountId}
            onChange={(event) => setStatusAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <select
            value={statusActiveFlag}
            onChange={(event) => setStatusActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            onClick={() => void updateUserStatus().catch((error) => setMessage(error instanceof Error ? error.message : 'Status update failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Update User Status
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Transfer Organization Admin</h2>
          <input
            value={transferOrgId}
            onChange={(event) => setTransferOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={transferFromAccountId}
            onChange={(event) => setTransferFromAccountId(event.target.value)}
            placeholder="from_account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={transferToAccountId}
            onChange={(event) => setTransferToAccountId(event.target.value)}
            placeholder="to_account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <select
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
            onClick={() => void transferAdmin().catch((error) => setMessage(error instanceof Error ? error.message : 'Transfer failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Transfer Admin
          </button>
        </section>

        <section className="space-y-3 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="text-lg font-bold">Manage Organization Membership</h2>
          <input
            value={membershipOrgId}
            onChange={(event) => setMembershipOrgId(event.target.value)}
            placeholder="organization_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <input
            value={membershipAccountId}
            onChange={(event) => setMembershipAccountId(event.target.value)}
            placeholder="account_id"
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          />
          <select
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
          <select
            value={membershipActiveFlag}
            onChange={(event) => setMembershipActiveFlag(event.target.value as 'active' | 'inactive')}
            className="h-11 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3"
          >
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>
          <button
            type="button"
            onClick={() => void manageMembership().catch((error) => setMessage(error instanceof Error ? error.message : 'Membership update failed'))}
            className="h-11 border-2 border-[var(--black)] bg-[var(--canvas-tan-dark)] px-4 text-sm font-black uppercase tracking-[0.12em]"
          >
            Update Membership
          </button>
        </section>

        {message ? <p className="text-sm font-semibold text-[var(--red-primary)]">{message}</p> : null}

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
