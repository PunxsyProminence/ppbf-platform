'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import {
  allTrackIds,
  athleteProfiles,
  loadTrackAssignments,
  readActiveAthleteProfileId,
  saveActiveAthleteProfileId,
  saveTrackAssignments,
  trackManifests,
  type TrackAssignments,
  type TrackID,
} from '@/components/trackAssignments';

type CapabilityStatus = 'DRAFT' | 'ACTIVE' | 'BLOCKED';

interface Capability {
  id: number;
  name: string;
  group: string;
  status: CapabilityStatus;
  createdAt: string;
}

const STORAGE_KEY = 'ppbf-admin-capabilities-v1';

const fallbackCapabilities: Capability[] = [
  {
    id: 1,
    name: 'Locker Rooms for Every Role',
    group: 'Core Platform',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    name: 'The Card File',
    group: 'Core Platform',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
  },
  {
    id: 3,
    name: 'Map Your Fight',
    group: 'Routing & Development',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
  },
];

function normalizeImportedCapabilities(input: unknown): Capability[] {
  if (!input || typeof input !== 'object' || !('original25Capabilities' in input)) {
    return fallbackCapabilities;
  }

  const raw = (input as { original25Capabilities?: unknown }).original25Capabilities;
  if (!Array.isArray(raw)) {
    return fallbackCapabilities;
  }

  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const row = item as { id?: unknown; name?: unknown; group?: unknown; status?: unknown };
      const statusCandidate = typeof row.status === 'string' ? row.status.toUpperCase() : 'DRAFT';
      const status: CapabilityStatus =
        statusCandidate === 'ACTIVE' || statusCandidate === 'BLOCKED' ? statusCandidate : 'DRAFT';

      return {
        id: typeof row.id === 'number' ? row.id : index + 1,
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `Capability ${index + 1}`,
        group: typeof row.group === 'string' && row.group.trim() ? row.group.trim() : 'General',
        status,
        createdAt: new Date().toISOString(),
      };
    });
}

export default function AdminCapabilitiesPage() {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('Core Platform');
  const [status, setStatus] = useState<CapabilityStatus>('DRAFT');
  const [selectedAthleteId, setSelectedAthleteId] = useState(() => readActiveAthleteProfileId());
  const [trackAssignments, setTrackAssignments] = useState<TrackAssignments>(() => loadTrackAssignments());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadCapabilities() {
      const localRaw = window.localStorage.getItem(STORAGE_KEY);
      if (localRaw) {
        try {
          const parsed = JSON.parse(localRaw) as Capability[];
          if (mounted && Array.isArray(parsed) && parsed.length > 0) {
            setCapabilities(parsed);
            setReady(true);
            return;
          }
        } catch {
          // Ignore broken local storage and proceed to preload file.
        }
      }

      try {
        const response = await fetch('/PPBF_CAPABILITIES.json');
        if (!response.ok) {
          throw new Error('Capability preload file not found');
        }

        const imported = await response.json();
        const normalized = normalizeImportedCapabilities(imported);
        if (mounted) {
          setCapabilities(normalized);
          setReady(true);
        }
      } catch {
        if (mounted) {
          setCapabilities(fallbackCapabilities);
          setReady(true);
        }
      }
    }

    void loadCapabilities();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (Object.keys(trackAssignments).length === 0) {
      return;
    }

    saveTrackAssignments(trackAssignments);
  }, [trackAssignments]);

  useEffect(() => {
    saveActiveAthleteProfileId(selectedAthleteId);
  }, [selectedAthleteId]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capabilities));
  }, [capabilities, ready]);

  const filteredCapabilities = useMemo(() => {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      return capabilities;
    }

    return capabilities.filter(
      (capability) =>
        capability.name.toLowerCase().includes(normalizedQuery) ||
        capability.group.toLowerCase().includes(normalizedQuery) ||
        capability.status.toLowerCase().includes(normalizedQuery),
    );
  }, [capabilities, query]);

  function addCapability() {
    if (!name.trim() || !group.trim()) {
      return;
    }

    const nextId = capabilities.length > 0 ? Math.max(...capabilities.map((item) => item.id)) + 1 : 1;

    setCapabilities((current) => [
      {
        id: nextId,
        name: name.trim(),
        group: group.trim(),
        status,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ]);

    setName('');
  }

  function exportCapabilities() {
    const payload = {
      version: '2.0.0-admin-export',
      generatedAt: new Date().toISOString(),
      count: capabilities.length,
      capabilities,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ppbf-capabilities-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function setCapabilityStatus(id: number, nextStatus: CapabilityStatus) {
    setCapabilities((current) =>
      current.map((capability) =>
        capability.id === id
          ? {
              ...capability,
              status: nextStatus,
            }
          : capability,
      ),
    );
  }

  function removeCapability(id: number) {
    setCapabilities((current) => current.filter((capability) => capability.id !== id));
  }

  function toggleTrackAssignment(trackId: TrackID) {
    setTrackAssignments((current) => {
      const existing = current[selectedAthleteId] ?? [];
      const next = existing.includes(trackId)
        ? existing.filter((id) => id !== trackId)
        : [...existing, trackId];

      return {
        ...current,
        [selectedAthleteId]: next.length > 0 ? next : ['non_contact'],
      };
    });
  }

  const assignedTracks = trackAssignments[selectedAthleteId] ?? ['non_contact'];

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <header className="flex items-center justify-between gap-3 border-b-4 border-[#8b4444] bg-[#1a1a1a] px-6 py-3 font-mono">
        <div className="text-lg font-bold tracking-[0.1em]">PPBF ADMIN</div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/shadow"
            className="border-2 border-[#8b4444] bg-[#5a2a2a] px-2 py-1.5 text-xs font-bold text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#8b4444] hover:text-[#e8d7c6]"
          >
            SHADOW
          </Link>
          <Link
            href="/operations"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-2 py-1.5 text-xs font-bold text-[#b0a095] transition hover:border-[#8a8a8a] hover:bg-[#4a4a4a]"
          >
            OPS HUB
          </Link>
          <Link
            href="/research/chat"
            className="border-2 border-[#d4a574] bg-[#5a4a3a] px-2 py-1.5 text-xs font-bold text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#8b4444]"
          >
            RESEARCH
          </Link>
        </div>
      </header>

      <section className="border-b-2 border-[#4a4a4a] bg-[#0f0f0f] px-6 py-2 font-mono text-xs tracking-[0.05em] text-[#b0a095]">
        All actions are logged. Jason approval required for production changes.
      </section>

      <div className="px-10 py-8">
        <h1 className="mb-6 font-display text-4xl tracking-tight text-[#e8d7c6]">Admin Dashboard - Capabilities</h1>

        <section className="mb-4 grid gap-3 border-2 border-[#8b4444] bg-[#1a1a1a] p-5 text-[#e8d7c6]">
          <h2 className="mb-1 text-xl text-[#e8d7c6]">Athlete Track Assignment</h2>

          <label className="text-sm text-[#a0a0a0]" htmlFor="athleteProfile">
            Active athlete profile
          </label>
          <select
            id="athleteProfile"
            value={selectedAthleteId}
            onChange={(event) => setSelectedAthleteId(event.target.value)}
            className="border-2 border-[#8b4444] bg-[#0f0f0f] px-2.5 py-2.5 font-mono text-[#e8d7c6]"
          >
            {athleteProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>

          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
            {allTrackIds.map((trackId) => {
              const assigned = assignedTracks.includes(trackId);
              return (
                <button
                  key={trackId}
                  type="button"
                  onClick={() => toggleTrackAssignment(trackId)}
                  className={`grid cursor-pointer gap-1 border-2 p-3 text-left font-mono ${
                    assigned
                      ? 'border-[#dc2626] bg-[#4a0000] text-[#ff6b6b]'
                      : 'border-[#8b4444] bg-[#0f0f0f] text-[#b0a095]'
                  }`}
                >
                  <strong className="text-sm">{trackManifests[trackId].name}</strong>
                  <span className={`text-xs ${assigned ? 'text-[#d4a574]' : 'text-[#8a8a8a]'}`}>{assigned ? 'Assigned' : 'Not assigned'}</span>
                </button>
              );
            })}
          </div>

          <p className="m-0 text-xs text-[#8a8a8a]">
            Athlete dashboards now only surface assigned tracks. Athletes can still review the full track catalog in read-only mode.
          </p>
        </section>

        <section className="mb-4 grid gap-3 border-2 border-[#8b4444] bg-[#1a1a1a] p-5 text-[#e8d7c6]">
          <h2 className="mb-1 text-xl text-[#e8d7c6]">Add Capability</h2>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Capability name"
            className="border-2 border-[#8b4444] bg-[#0f0f0f] px-2.5 py-2.5 font-mono text-[#e8d7c6]"
          />

          <input
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="Capability group"
            className="border-2 border-[#8b4444] bg-[#0f0f0f] px-2.5 py-2.5 font-mono text-[#e8d7c6]"
          />

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CapabilityStatus)}
            className="border-2 border-[#8b4444] bg-[#0f0f0f] px-2.5 py-2.5 font-mono text-[#e8d7c6]"
          >
            <option value="DRAFT">DRAFT</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="BLOCKED">BLOCKED</option>
          </select>

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={addCapability}
              className="cursor-pointer border-2 border-[#8b4444] bg-[#dc2626] px-3.5 py-2.5 font-mono font-bold text-[#e8d7c6]"
            >
              Add Capability
            </button>

            <button
              type="button"
              onClick={exportCapabilities}
              className="cursor-pointer border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-2.5 font-mono font-bold text-[#d4a574]"
            >
              Export JSON
            </button>
          </div>
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-5 text-[#e8d7c6]">
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="text-xl text-[#e8d7c6]">Capability Catalog ({filteredCapabilities.length})</h2>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, group, or status"
              className="min-w-[260px] border-2 border-[#8b4444] bg-[#0f0f0f] px-2.5 py-2.5 font-mono text-[#e8d7c6]"
            />
          </div>

          <div className="mt-4 grid gap-2.5">
            {filteredCapabilities.map((capability) => {
              let statusClass = 'text-[#d4a574]';
              if (capability.status === 'ACTIVE') {
                statusClass = 'text-[#dc2626]';
              } else if (capability.status === 'BLOCKED') {
                statusClass = 'text-[#ff6b6b]';
              }

              return (
                <article
                  key={capability.id}
                  className="grid gap-1 border border-[#4a4a4a] bg-[#0f0f0f] p-3 text-[#e8d7c6]"
                >
                  <strong>
                    #{capability.id} - {capability.name}
                  </strong>
                  <span className="text-[#b0a095]">Group: {capability.group}</span>
                  <span className="text-[#b0a095]">Status: <span className={statusClass}>{capability.status}</span></span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setCapabilityStatus(capability.id, 'DRAFT')}
                      className="border border-[#5a4a3a] bg-[#1a1a1a] px-2 py-1 text-xs font-mono text-[#b0a095] transition hover:border-[#d4a574] hover:text-[#e8d7c6]"
                    >
                      Set DRAFT
                    </button>
                    <button
                      type="button"
                      onClick={() => setCapabilityStatus(capability.id, 'ACTIVE')}
                      className="border border-[#8b4444] bg-[#5a2a2a] px-2 py-1 text-xs font-mono text-[#e8d7c6] transition hover:border-[#d4a574]"
                    >
                      Set ACTIVE
                    </button>
                    <button
                      type="button"
                      onClick={() => setCapabilityStatus(capability.id, 'BLOCKED')}
                      className="border border-[#dc2626] bg-[#450a0a] px-2 py-1 text-xs font-mono text-[#fca5a5] transition hover:border-[#ff6b6b]"
                    >
                      Set BLOCKED
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCapability(capability.id)}
                      className="border border-[#4a4a4a] bg-[#0a0a0a] px-2 py-1 text-xs font-mono text-[#b0a095] transition hover:border-[#ff6b6b] hover:text-[#fca5a5]"
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
      </main>
    </RoleSessionGate>
  );
}