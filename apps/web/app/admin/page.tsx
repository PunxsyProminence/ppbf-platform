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
    name: 'Multi-role portals',
    group: 'Core Platform',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    name: 'Participant master record service',
    group: 'Core Platform',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
  },
  {
    id: 3,
    name: 'Goal Intake -> Routing Service',
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
  const [selectedAthleteId, setSelectedAthleteId] = useState(athleteProfiles[0].id);
  const [trackAssignments, setTrackAssignments] = useState<TrackAssignments>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTrackAssignments(loadTrackAssignments());
    setSelectedAthleteId(readActiveAthleteProfileId());

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
    <main style={{ minHeight: '100vh', background: '#f8f9fa', color: '#111' }}>
      <header
        style={{
          background: '#111',
          color: 'white',
          padding: '16px 40px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <strong>PPBF</strong> Platform
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <Link
            href="/operations"
            style={{
              fontSize: '0.8rem',
              border: '1px solid rgba(34,211,238,0.5)',
              background: 'rgba(34,211,238,0.15)',
              color: '#cffafe',
              borderRadius: '8px',
              padding: '6px 10px',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            Operations Hub
          </Link>
          <Link
            href="/launch"
            style={{
              fontSize: '0.8rem',
              border: '1px solid #4b5563',
              color: '#e5e7eb',
              borderRadius: '8px',
              padding: '6px 10px',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            Launch Portal
          </Link>
          <div style={{ fontSize: '0.9rem' }}>Governed by Layer 0</div>
        </div>
      </header>

      <section
        style={{
          background: '#fefce8',
          padding: '8px 40px',
          fontSize: '0.875rem',
          borderBottom: '1px solid #fde047',
        }}
      >
        All actions are logged. Jason approval required for production changes.
      </section>

      <div style={{ padding: '32px 40px' }}>
        <h1 style={{ marginBottom: '24px', fontSize: '2rem' }}>Admin Dashboard - Capabilities</h1>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #ddd',
            borderRadius: '10px',
            background: 'white',
            marginBottom: '18px',
          }}
        >
          <h2 style={{ fontSize: '1.2rem', marginBottom: '4px' }}>Athlete Track Assignment</h2>

          <label style={{ fontSize: '0.85rem', color: '#4b5563' }} htmlFor="athleteProfile">
            Active athlete profile
          </label>
          <select
            id="athleteProfile"
            value={selectedAthleteId}
            onChange={(event) => setSelectedAthleteId(event.target.value)}
            style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
          >
            {athleteProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>

          <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            {allTrackIds.map((trackId) => {
              const assigned = assignedTracks.includes(trackId);
              return (
                <button
                  key={trackId}
                  type="button"
                  onClick={() => toggleTrackAssignment(trackId)}
                  style={{
                    textAlign: 'left',
                    borderRadius: '10px',
                    border: assigned ? '1px solid #16a34a' : '1px solid #d1d5db',
                    background: assigned ? '#ecfdf3' : 'white',
                    color: '#111827',
                    padding: '12px',
                    cursor: 'pointer',
                    display: 'grid',
                    gap: '4px',
                  }}
                >
                  <strong style={{ fontSize: '0.9rem' }}>{trackManifests[trackId].name}</strong>
                  <span style={{ fontSize: '0.75rem', color: '#4b5563' }}>{assigned ? 'Assigned' : 'Not assigned'}</span>
                </button>
              );
            })}
          </div>

          <p style={{ margin: 0, fontSize: '0.78rem', color: '#6b7280' }}>
            Athlete dashboards now only surface assigned tracks. Athletes can still review the full track catalog in read-only mode.
          </p>
        </section>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '1px solid #ddd',
            borderRadius: '10px',
            background: 'white',
            marginBottom: '18px',
          }}
        >
          <h2 style={{ fontSize: '1.2rem', marginBottom: '4px' }}>Add Capability</h2>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Capability name"
            style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
          />

          <input
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="Capability group"
            style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
          />

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CapabilityStatus)}
            style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '8px' }}
          >
            <option value="DRAFT">DRAFT</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="BLOCKED">BLOCKED</option>
          </select>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={addCapability}
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                border: 'none',
                background: '#111',
                color: 'white',
                cursor: 'pointer',
              }}
            >
              Add Capability
            </button>

            <button
              type="button"
              onClick={exportCapabilities}
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid #111',
                background: 'white',
                color: '#111',
                cursor: 'pointer',
              }}
            >
              Export JSON
            </button>
          </div>
        </section>

        <section
          style={{
            border: '1px solid #ddd',
            borderRadius: '10px',
            background: 'white',
            padding: '18px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1.2rem' }}>Capability Catalog ({filteredCapabilities.length})</h2>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, group, or status"
              style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '8px', minWidth: '260px' }}
            />
          </div>

          <div style={{ marginTop: '16px', display: 'grid', gap: '10px' }}>
            {filteredCapabilities.map((capability) => (
              <article
                key={capability.id}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  padding: '12px',
                  display: 'grid',
                  gap: '4px',
                }}
              >
                <strong>
                  #{capability.id} - {capability.name}
                </strong>
                <span style={{ color: '#374151' }}>Group: {capability.group}</span>
                <span style={{ color: '#374151' }}>Status: {capability.status}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
    </RoleSessionGate>
  );
}