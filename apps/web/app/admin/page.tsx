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
    <main style={{ minHeight: '100vh', background: '#0a0a0a', color: '#e8d7c6' }}>
      <header
        style={{
          background: '#1a1a1a',
          color: '#e8d7c6',
          padding: '12px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '4px solid #8b4444',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ fontWeight: 'bold', fontSize: '1.1rem', letterSpacing: '0.1em' }}>PPBF ADMIN</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Link
            href="/admin/shadow"
            style={{
              fontSize: '0.75rem',
              border: '2px solid #8b4444',
              background: '#5a2a2a',
              color: '#d4a574',
              padding: '6px 8px',
              textDecoration: 'none',
              fontWeight: 700,
              fontFamily: 'monospace',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseOver={(e) => {
              (e.target as HTMLElement).style.background = '#8b4444';
              (e.target as HTMLElement).style.borderColor = '#d4a574';
              (e.target as HTMLElement).style.color = '#e8d7c6';
            }}
            onMouseOut={(e) => {
              (e.target as HTMLElement).style.background = '#5a2a2a';
              (e.target as HTMLElement).style.borderColor = '#8b4444';
              (e.target as HTMLElement).style.color = '#d4a574';
            }}
          >
            SHADOW
          </Link>
          <Link
            href="/operations"
            style={{
              fontSize: '0.75rem',
              border: '2px solid #8b4444',
              background: '#1a1a1a',
              color: '#b0a095',
              padding: '6px 8px',
              textDecoration: 'none',
              fontWeight: 700,
              fontFamily: 'monospace',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseOver={(e) => {
              (e.target as HTMLElement).style.background = '#4a4a4a';
              (e.target as HTMLElement).style.borderColor = '#8a8a8a';
            }}
            onMouseOut={(e) => {
              (e.target as HTMLElement).style.background = '#1a1a1a';
              (e.target as HTMLElement).style.borderColor = '#8b4444';
            }}
          >
            OPS HUB
          </Link>
          <Link
            href="/research/chat"
            style={{
              fontSize: '0.75rem',
              border: '2px solid #d4a574',
              background: '#5a4a3a',
              color: '#d4a574',
              padding: '6px 8px',
              textDecoration: 'none',
              fontWeight: 700,
              fontFamily: 'monospace',
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseOver={(e) => {
              (e.target as HTMLElement).style.background = '#8b4444';
              (e.target as HTMLElement).style.borderColor = '#d4a574';
            }}
            onMouseOut={(e) => {
              (e.target as HTMLElement).style.background = '#5a4a3a';
              (e.target as HTMLElement).style.borderColor = '#d4a574';
            }}
          >
            RESEARCH
          </Link>
        </div>
      </header>

      <section
        style={{
          background: '#0f0f0f',
          padding: '8px 24px',
          fontSize: '0.75rem',
          borderBottom: '2px solid #4a4a4a',
          fontFamily: 'monospace',
          letterSpacing: '0.05em',
          color: '#b0a095',
        }}
      >
        All actions are logged. Jason approval required for production changes.
      </section>

      <div style={{ padding: '32px 40px' }}>
        <h1 style={{ marginBottom: '24px', fontSize: '2rem', color: '#e8d7c6' }}>Admin Dashboard - Capabilities</h1>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '2px solid #8b4444',
            background: '#1a1a1a',
            marginBottom: '18px',
            color: '#e8d7c6',
          }}
        >
          <h2 style={{ fontSize: '1.2rem', marginBottom: '4px', color: '#e5e5e5' }}>Athlete Track Assignment</h2>

          <label style={{ fontSize: '0.85rem', color: '#a0a0a0' }} htmlFor="athleteProfile">
            Active athlete profile
          </label>
          <select
            id="athleteProfile"
            value={selectedAthleteId}
            onChange={(event) => setSelectedAthleteId(event.target.value)}
            style={{ padding: '10px', border: '2px solid #8b4444', background: '#0f0f0f', color: '#e8d7c6', fontFamily: 'monospace' }}
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
                    border: assigned ? '2px solid #dc2626' : '2px solid #8b4444',
                    background: assigned ? '#4a0000' : '#0f0f0f',
                    color: assigned ? '#ff6b6b' : '#b0a095',
                    padding: '12px',
                    cursor: 'pointer',
                    display: 'grid',
                    gap: '4px',
                    fontFamily: 'monospace',
                  }}
                >
                  <strong style={{ fontSize: '0.9rem' }}>{trackManifests[trackId].name}</strong>
                  <span style={{ fontSize: '0.75rem', color: assigned ? '#d4a574' : '#8a8a8a' }}>{assigned ? 'Assigned' : 'Not assigned'}</span>
                </button>
              );
            })}
          </div>

          <p style={{ margin: 0, fontSize: '0.78rem', color: '#8a8a8a' }}>
            Athlete dashboards now only surface assigned tracks. Athletes can still review the full track catalog in read-only mode.
          </p>
        </section>

        <section
          style={{
            display: 'grid',
            gap: '12px',
            padding: '18px',
            border: '2px solid #8b4444',
            background: '#1a1a1a',
            marginBottom: '18px',
            color: '#e8d7c6',
          }}
        >
          <h2 style={{ fontSize: '1.2rem', marginBottom: '4px', color: '#e8d7c6' }}>Add Capability</h2>

          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Capability name"
            style={{ padding: '10px', border: '2px solid #8b4444', background: '#0f0f0f', color: '#e8d7c6', fontFamily: 'monospace' }}
          />

          <input
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            placeholder="Capability group"
            style={{ padding: '10px', border: '2px solid #8b4444', background: '#0f0f0f', color: '#e8d7c6', fontFamily: 'monospace' }}
          />

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CapabilityStatus)}
            style={{ padding: '10px', border: '2px solid #8b4444', background: '#0f0f0f', color: '#e8d7c6', fontFamily: 'monospace' }}
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
                border: '2px solid #8b4444',
                background: '#dc2626',
                color: '#e8d7c6',
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontWeight: 'bold',
              }}
            >
              Add Capability
            </button>

            <button
              type="button"
              onClick={exportCapabilities}
              style={{
                padding: '10px 14px',
                border: '2px solid #8b4444',
                background: '#0f0f0f',
                color: '#d4a574',
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontWeight: 'bold',
              }}
            >
              Export JSON
            </button>
          </div>
        </section>

        <section
          style={{
            border: '2px solid #8b4444',
            background: '#1a1a1a',
            padding: '18px',
            color: '#e8d7c6',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: '1.2rem', color: '#e8d7c6' }}>Capability Catalog ({filteredCapabilities.length})</h2>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, group, or status"
              style={{ padding: '10px', border: '2px solid #8b4444', background: '#0f0f0f', color: '#e8d7c6', fontFamily: 'monospace', minWidth: '260px' }}
            />
          </div>

          <div style={{ marginTop: '16px', display: 'grid', gap: '10px' }}>
            {filteredCapabilities.map((capability) => (
              <article
                key={capability.id}
                style={{
                  border: '1px solid #4a4a4a',
                  padding: '12px',
                  display: 'grid',
                  gap: '4px',
                  background: '#0f0f0f',
                  color: '#e8d7c6',
                }}
              >
                <strong>
                  #{capability.id} - {capability.name}
                </strong>
                <span style={{ color: '#b0a095' }}>Group: {capability.group}</span>
                <span style={{ color: '#b0a095' }}>Status: <span style={{ color: capability.status === 'ACTIVE' ? '#dc2626' : capability.status === 'BLOCKED' ? '#ff6b6b' : '#d4a574' }}>{capability.status}</span></span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
    </RoleSessionGate>
  );
}