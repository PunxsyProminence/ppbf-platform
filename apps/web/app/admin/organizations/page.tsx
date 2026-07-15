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
