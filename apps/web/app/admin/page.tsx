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

type CapabilityStatus = 'DRAFT' | 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';
type CapabilityVisibility = 'Internal' | 'Role-Bound' | 'Public Placeholder';
type TabKey = 'overview' | 'library' | 'matrix' | 'builder';
type AssignmentFilter = 'all' | 'assigned' | 'unassigned';
type MatrixFilter = 'all' | 'unassigned' | 'multi-role' | 'draft' | 'active';

type RoleName =
  | 'Athlete'
  | 'Coach'
  | 'Parent / Guardian'
  | 'Admin'
  | 'Board'
  | 'Safety'
  | 'Auditor'
  | 'Public';

interface Capability {
  id: number;
  capabilityId: string;
  name: string;
  group: string;
  status: CapabilityStatus;
  visibility: CapabilityVisibility;
  owner: string;
  assignedRoles: RoleName[];
  description: string;
  dependencies: string;
  notes: string;
  reviewNeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EventTrace {
  timestamp: string;
  action: string;
  detail: string;
}

interface CapabilityRepository {
  load: () => Capability[];
  save: (items: Capability[]) => void;
}

const STORAGE_KEY = 'ppbf-admin-capabilities-v1';
const OWNER_OPTIONS = ['Operations', 'Program Team', 'Board Office', 'Safety Office', 'Admin Control'];
const CATEGORY_OPTIONS = ['Core Platform', 'Routing & Development', 'Safety & Compliance', 'Program Operations'];
const ROLE_OPTIONS: RoleName[] = [
  'Athlete',
  'Coach',
  'Parent / Guardian',
  'Admin',
  'Board',
  'Safety',
  'Auditor',
  'Public',
];

const TRACK_CAPABILITY_PREVIEW: Record<TrackID, string[]> = {
  non_contact: ['CAP-001'],
  usa_boxing: ['CAP-001', 'CAP-003'],
  a2p: ['CAP-002', 'CAP-003'],
  pro: ['CAP-002', 'CAP-003'],
  collegiate: ['CAP-001', 'CAP-003'],
  usa_masters: ['CAP-001', 'CAP-002'],
  spec_ops: ['CAP-002'],
};

const INTEGRATION_STUBS = [
  'Capability CRUD adapter (replace localStorage repository)',
  'Role-assignment policy adapter (replace local matrix toggles)',
  'Audit telemetry dispatcher (replace local event trace list)',
  'Authoritative timestamp source (replace local Date values)',
  'Track-capability mapping service (replace preview map)',
];

const fallbackCapabilities: Capability[] = [
  {
    id: 1,
    capabilityId: 'CAP-001',
    name: 'Locker Rooms for Every Role',
    group: 'Core Platform',
    status: 'DRAFT',
    visibility: 'Role-Bound',
    owner: 'Operations',
    assignedRoles: ['Athlete', 'Coach', 'Admin'],
    description: 'Role-based locker room entry points and contextual dashboards.',
    dependencies: 'Session role map',
    notes: 'Needs assignment review for Parent / Guardian.',
    reviewNeeded: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 2,
    capabilityId: 'CAP-002',
    name: 'The Card File',
    group: 'Core Platform',
    status: 'ACTIVE',
    visibility: 'Internal',
    owner: 'Admin Control',
    assignedRoles: ['Admin', 'Board', 'Auditor'],
    description: 'Capability catalog and governance metadata index.',
    dependencies: 'Capability state map',
    notes: 'Stable baseline capability.',
    reviewNeeded: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 3,
    capabilityId: 'CAP-003',
    name: 'Map Your Fight',
    group: 'Routing & Development',
    status: 'DRAFT',
    visibility: 'Role-Bound',
    owner: 'Program Team',
    assignedRoles: ['Athlete', 'Coach'],
    description: 'Route guidance and mission-control view alignment.',
    dependencies: 'Route matrix',
    notes: 'Pending validation before ACTIVE promotion.',
    reviewNeeded: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function toCapabilityStatus(raw: unknown): CapabilityStatus {
  if (typeof raw !== 'string') return 'DRAFT';
  const statusCandidate = raw.toUpperCase();
  if (statusCandidate === 'ACTIVE') return 'ACTIVE';
  if (statusCandidate === 'BLOCKED') return 'BLOCKED';
  if (statusCandidate === 'ARCHIVED') return 'ARCHIVED';
  return 'DRAFT';
}

function toRoleList(raw: unknown): RoleName[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((role): role is RoleName => ROLE_OPTIONS.includes(role as RoleName));
}

function hydrateCapability(source: Partial<Capability>, index: number): Capability {
  const nowIso = new Date().toISOString();
  const capabilityName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `Capability ${index + 1}`;
  const assignedRoles = toRoleList(source.assignedRoles);
  return {
    id: typeof source.id === 'number' ? source.id : index + 1,
    capabilityId:
      typeof source.capabilityId === 'string' && source.capabilityId.trim()
        ? source.capabilityId.trim()
        : `CAP-${String(index + 1).padStart(3, '0')}`,
    name: capabilityName,
    group: typeof source.group === 'string' && source.group.trim() ? source.group.trim() : 'General',
    status: toCapabilityStatus(source.status),
    visibility:
      source.visibility === 'Internal' || source.visibility === 'Role-Bound' || source.visibility === 'Public Placeholder'
        ? source.visibility
        : 'Role-Bound',
    owner: typeof source.owner === 'string' && source.owner.trim() ? source.owner.trim() : 'Operations',
    assignedRoles,
    description:
      typeof source.description === 'string' && source.description.trim()
        ? source.description.trim()
        : `${capabilityName} capability definition pending detailed admin notes.`,
    dependencies: typeof source.dependencies === 'string' ? source.dependencies : '',
    notes: typeof source.notes === 'string' ? source.notes : '',
    reviewNeeded: typeof source.reviewNeeded === 'boolean' ? source.reviewNeeded : toCapabilityStatus(source.status) === 'DRAFT',
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowIso,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowIso,
  };
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return date.toLocaleDateString();
}

const localCapabilityRepository: CapabilityRepository = {
  load: () => {
    if (typeof window === 'undefined') {
      return fallbackCapabilities;
    }

    const localRaw = window.localStorage.getItem(STORAGE_KEY);
    if (!localRaw) {
      return fallbackCapabilities;
    }

    try {
      const parsed = JSON.parse(localRaw) as Partial<Capability>[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item, index) => hydrateCapability(item, index));
      }
    } catch {
      return fallbackCapabilities;
    }

    return fallbackCapabilities;
  },
  save: (items) => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  },
};

export default function AdminCapabilitiesPage() {
  const [capabilities, setCapabilities] = useState<Capability[]>(() => localCapabilityRepository.load());
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [selectedAthleteId, setSelectedAthleteId] = useState(() => readActiveAthleteProfileId());
  const [trackAssignments, setTrackAssignments] = useState<TrackAssignments>(() => loadTrackAssignments());

  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<'ALL' | RoleName>('ALL');
  const [filterCategory, setFilterCategory] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState<'ALL' | CapabilityStatus>('ALL');
  const [filterOwner, setFilterOwner] = useState('ALL');
  const [filterVisibility, setFilterVisibility] = useState<'ALL' | CapabilityVisibility>('ALL');
  const [filterAssignment, setFilterAssignment] = useState<AssignmentFilter>('all');
  const [matrixFilter, setMatrixFilter] = useState<MatrixFilter>('all');

  const [expandedCapabilityId, setExpandedCapabilityId] = useState<number | null>(null);
  const [assignmentFocusId, setAssignmentFocusId] = useState<number | null>(null);

  const [editingCapabilityId, setEditingCapabilityId] = useState<number | null>(null);
  const [builderName, setBuilderName] = useState('');
  const [builderCapabilityId, setBuilderCapabilityId] = useState('');
  const [builderCategory, setBuilderCategory] = useState('Core Platform');
  const [builderDescription, setBuilderDescription] = useState('');
  const [builderPrimaryRole, setBuilderPrimaryRole] = useState<RoleName>('Admin');
  const [builderSecondaryRoles, setBuilderSecondaryRoles] = useState<RoleName[]>([]);
  const [builderStatus, setBuilderStatus] = useState<CapabilityStatus>('DRAFT');
  const [builderVisibility, setBuilderVisibility] = useState<CapabilityVisibility>('Role-Bound');
  const [builderOwner, setBuilderOwner] = useState('Operations');
  const [builderDependencies, setBuilderDependencies] = useState('');
  const [builderNotes, setBuilderNotes] = useState('');

  const [eventTraces, setEventTraces] = useState<EventTrace[]>([]);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [showIntegrationStubs, setShowIntegrationStubs] = useState(false);

  function logTrace(action: string, detail: string) {
    const trace: EventTrace = {
      timestamp: new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      action,
      detail,
    };

    setEventTraces((current) => [trace, ...current].slice(0, 40));
  }

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
    localCapabilityRepository.save(capabilities);
  }, [capabilities]);

  const categoryOptions = useMemo(
    () => ['ALL', ...new Set([...CATEGORY_OPTIONS, ...capabilities.map((item) => item.group)])],
    [capabilities],
  );
  const ownerOptions = useMemo(() => ['ALL', ...new Set(capabilities.map((item) => item.owner)), ...OWNER_OPTIONS], [capabilities]);

  const filteredCapabilities = useMemo(() => {
    const normalizedQuery = searchQuery.toLowerCase().trim();

    return capabilities.filter((capability) => {
      const matchesQuery =
        !normalizedQuery ||
        capability.name.toLowerCase().includes(normalizedQuery) ||
        capability.capabilityId.toLowerCase().includes(normalizedQuery) ||
        capability.group.toLowerCase().includes(normalizedQuery) ||
        capability.description.toLowerCase().includes(normalizedQuery);

      const matchesRole = filterRole === 'ALL' || capability.assignedRoles.includes(filterRole);
      const matchesCategory = filterCategory === 'ALL' || capability.group === filterCategory;
      const matchesStatus = filterStatus === 'ALL' || capability.status === filterStatus;
      const matchesOwner = filterOwner === 'ALL' || capability.owner === filterOwner;
      const matchesVisibility = filterVisibility === 'ALL' || capability.visibility === filterVisibility;
      const matchesAssignment =
        filterAssignment === 'all' ||
        (filterAssignment === 'assigned' && capability.assignedRoles.length > 0) ||
        (filterAssignment === 'unassigned' && capability.assignedRoles.length === 0);

      return (
        matchesQuery &&
        matchesRole &&
        matchesCategory &&
        matchesStatus &&
        matchesOwner &&
        matchesVisibility &&
        matchesAssignment
      );
    });
  }, [capabilities, filterAssignment, filterCategory, filterOwner, filterRole, filterStatus, filterVisibility, searchQuery]);

  const matrixCapabilities = useMemo(() => {
    return capabilities.filter((capability) => {
      if (matrixFilter === 'unassigned') return capability.assignedRoles.length === 0;
      if (matrixFilter === 'multi-role') return capability.assignedRoles.length > 1;
      if (matrixFilter === 'draft') return capability.status === 'DRAFT';
      if (matrixFilter === 'active') return capability.status === 'ACTIVE';
      return true;
    });
  }, [capabilities, matrixFilter]);

  const dashboardCounts = useMemo(() => {
    const total = capabilities.length;
    const active = capabilities.filter((item) => item.status === 'ACTIVE').length;
    const draft = capabilities.filter((item) => item.status === 'DRAFT').length;
    const assigned = capabilities.filter((item) => item.assignedRoles.length > 0).length;
    const unassigned = capabilities.filter((item) => item.assignedRoles.length === 0).length;
    const archived = capabilities.filter((item) => item.status === 'ARCHIVED').length;

    return { total, active, draft, assigned, unassigned, archived };
  }, [capabilities]);

  const roleExposureSnapshot = useMemo(() => {
    return ROLE_OPTIONS.map((role) => ({
      role,
      count: capabilities.filter((capability) => capability.assignedRoles.includes(role)).length,
    }));
  }, [capabilities]);

  const recentlyUpdated = useMemo(() => {
    return [...capabilities]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 6);
  }, [capabilities]);

  const missingAssignments = useMemo(() => capabilities.filter((item) => item.assignedRoles.length === 0), [capabilities]);
  const pendingReview = useMemo(() => capabilities.filter((item) => item.reviewNeeded || item.status === 'DRAFT'), [capabilities]);
  const draftCapabilities = useMemo(() => capabilities.filter((item) => item.status === 'DRAFT'), [capabilities]);

  const assignedTracks = trackAssignments[selectedAthleteId] ?? ['non_contact'];

  function updateCapability(id: number, updater: (source: Capability) => Capability) {
    setCapabilities((current) =>
      current.map((capability) => (capability.id === id ? { ...updater(capability), updatedAt: new Date().toISOString() } : capability)),
    );
  }

  function toggleTrackAssignment(trackId: TrackID) {
    setTrackAssignments((current) => {
      const existing = current[selectedAthleteId] ?? [];
      const next = existing.includes(trackId) ? existing.filter((id) => id !== trackId) : [...existing, trackId];

      return {
        ...current,
        [selectedAthleteId]: next.length > 0 ? next : ['non_contact'],
      };
    });
  }

  function setCapabilityStatus(id: number, nextStatus: CapabilityStatus) {
    updateCapability(id, (capability) => ({
      ...capability,
      status: nextStatus,
      reviewNeeded: nextStatus === 'DRAFT',
    }));
    logTrace('capability status changed', `Capability #${id} -> ${nextStatus}`);
  }

  function removeCapability(id: number) {
    setCapabilities((current) => current.filter((capability) => capability.id !== id));
    if (editingCapabilityId === id) {
      resetBuilder();
    }
    logTrace('capability archived', `Capability #${id} removed from local console`);
  }

  function toggleCapabilityRole(id: number, role: RoleName) {
    updateCapability(id, (capability) => {
      const roleExists = capability.assignedRoles.includes(role);
      const nextRoles = roleExists ? capability.assignedRoles.filter((item) => item !== role) : [...capability.assignedRoles, role];
      return {
        ...capability,
        assignedRoles: nextRoles,
        reviewNeeded: capability.status === 'DRAFT' || nextRoles.length === 0,
      };
    });
    logTrace('capability assigned', `Capability #${id} role toggled: ${role}`);
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

  function resetBuilder() {
    setEditingCapabilityId(null);
    setBuilderName('');
    setBuilderCapabilityId('');
    setBuilderCategory('Core Platform');
    setBuilderDescription('');
    setBuilderPrimaryRole('Admin');
    setBuilderSecondaryRoles([]);
    setBuilderStatus('DRAFT');
    setBuilderVisibility('Role-Bound');
    setBuilderOwner('Operations');
    setBuilderDependencies('');
    setBuilderNotes('');
  }

  function beginEdit(capability: Capability) {
    setEditingCapabilityId(capability.id);
    setBuilderName(capability.name);
    setBuilderCapabilityId(capability.capabilityId);
    setBuilderCategory(capability.group);
    setBuilderDescription(capability.description);
    setBuilderPrimaryRole(capability.assignedRoles[0] ?? 'Admin');
    setBuilderSecondaryRoles(capability.assignedRoles.slice(1));
    setBuilderStatus(capability.status);
    setBuilderVisibility(capability.visibility);
    setBuilderOwner(capability.owner);
    setBuilderDependencies(capability.dependencies);
    setBuilderNotes(capability.notes);
    setActiveTab('builder');
    logTrace('capability edited', `Editing ${capability.capabilityId} - ${capability.name}`);
  }

  function toggleSecondaryRole(role: RoleName) {
    setBuilderSecondaryRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  }

  function saveCapability() {
    if (!builderName.trim() || !builderCategory.trim()) {
      return;
    }

    const allRoles = [builderPrimaryRole, ...builderSecondaryRoles.filter((role) => role !== builderPrimaryRole)];

    if (editingCapabilityId !== null) {
      updateCapability(editingCapabilityId, (capability) => ({
        ...capability,
        capabilityId: builderCapabilityId.trim() || capability.capabilityId,
        name: builderName.trim(),
        group: builderCategory.trim(),
        description: builderDescription.trim() || capability.description,
        assignedRoles: allRoles,
        status: builderStatus,
        visibility: builderVisibility,
        owner: builderOwner.trim() || capability.owner,
        dependencies: builderDependencies.trim(),
        notes: builderNotes.trim(),
        reviewNeeded: builderStatus === 'DRAFT' || allRoles.length === 0,
      }));
      logTrace('capability edited', `Saved edits for capability #${editingCapabilityId}`);
    } else {
      const nextId = capabilities.length > 0 ? Math.max(...capabilities.map((item) => item.id)) + 1 : 1;
      const nowIso = new Date().toISOString();
      const nextCapability: Capability = {
        id: nextId,
        capabilityId: builderCapabilityId.trim() || `CAP-${String(nextId).padStart(3, '0')}`,
        name: builderName.trim(),
        group: builderCategory.trim(),
        status: builderStatus,
        visibility: builderVisibility,
        owner: builderOwner.trim() || 'Operations',
        assignedRoles: allRoles,
        description: builderDescription.trim() || `${builderName.trim()} capability description pending detail.`,
        dependencies: builderDependencies.trim(),
        notes: builderNotes.trim(),
        reviewNeeded: builderStatus === 'DRAFT' || allRoles.length === 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setCapabilities((current) => [nextCapability, ...current]);
      logTrace('capability created', `Created ${nextCapability.capabilityId} - ${nextCapability.name}`);
    }

    resetBuilder();
  }

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
        <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">PPBF ADMIN AUTHORITY CONSOLE</p>
              <h1 className="mt-2 font-display text-[32px] font-black tracking-tight text-[#f2e7da]">Capability Management Console</h1>
              <p className="mt-2 max-w-4xl text-[16px] leading-7 text-[#cfbfae]">
                Control capability definitions, assignments, status, and role exposure across the PPBF ecosystem.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/admin/shadow"
                className="inline-flex h-11 items-center border border-[#8b4444] bg-[#5a2a2a] px-4 text-[14px] font-bold text-[#f2e7da] transition hover:bg-[#7a3a3a]"
              >
                SHADOW
              </Link>
              <Link
                href="/operations"
                className="inline-flex h-11 items-center border border-[#5a4a3a] bg-[#111111] px-4 text-[14px] font-bold text-[#cfbfae] transition hover:border-[#8b4444]"
              >
                MISSION CONTROL
              </Link>
              <button
                type="button"
                onClick={exportCapabilities}
                className="inline-flex h-11 items-center border border-[#8b4444] bg-[#0f0f0f] px-4 text-[14px] font-bold text-[#d4a574] transition hover:border-[#d4a574]"
              >
                EXPORT JSON
              </button>
            </div>
          </div>
        </header>

        <section className="border-b border-[#4a4a4a] bg-[#111111] px-6 py-3 text-[14px] text-[#b0a095]">
          All actions remain local to this front-end console. Jason approval required for production changes.
        </section>

        <div className="mx-auto max-w-[1500px] space-y-8 px-6 py-8">
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {[
              { label: 'TOTAL CAPABILITIES', value: dashboardCounts.total },
              { label: 'ACTIVE', value: dashboardCounts.active },
              { label: 'DRAFT', value: dashboardCounts.draft },
              { label: 'ASSIGNED', value: dashboardCounts.assigned },
              { label: 'UNASSIGNED', value: dashboardCounts.unassigned },
              { label: 'ARCHIVED', value: dashboardCounts.archived },
            ].map((card) => (
              <article key={card.label} className="border border-[#3a3a3a] bg-[#161616] px-4 py-4">
                <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">{card.label}</p>
                <p className="mt-2 text-[30px] font-black text-[#f2e7da]">{card.value}</p>
              </article>
            ))}
          </section>

          <section className="flex flex-wrap gap-2 border border-[#3a3a3a] bg-[#121212] p-2">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'library', label: 'Capability Library' },
              { id: 'matrix', label: 'Assignment Matrix' },
              { id: 'builder', label: 'Capability Builder' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id as TabKey);
                  logTrace('tab changed', tab.label);
                }}
                className={`h-11 border px-4 text-[14px] font-bold ${
                  activeTab === tab.id
                    ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                    : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae] hover:border-[#8b4444]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </section>

          {activeTab === 'overview' && (
            <section className="grid gap-6">
              <article className="border border-[#3a3a3a] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">Operational Overview</h2>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="text-[18px] font-semibold text-[#f2e7da]">Recently Updated Capabilities</h3>
                    {recentlyUpdated.map((capability) => (
                      <div key={capability.id} className="border border-[#2d2d2d] bg-[#1a1a1a] px-4 py-3">
                        <p className="text-[16px] font-semibold text-[#f2e7da]">{capability.capabilityId} - {capability.name}</p>
                        <p className="text-[14px] text-[#bfb3a6]">{capability.group} • {capability.status}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-[18px] font-semibold text-[#f2e7da]">Role Exposure Snapshot</h3>
                    {roleExposureSnapshot.map((item) => (
                      <div key={item.role} className="flex items-center justify-between border border-[#2d2d2d] bg-[#1a1a1a] px-4 py-3">
                        <p className="text-[16px] text-[#f2e7da]">{item.role}</p>
                        <p className="text-[16px] font-bold text-[#d4a574]">{item.count}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </article>

              <article className="border border-[#3a3a3a] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">Workload Buckets</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div className="border border-[#2d2d2d] bg-[#1a1a1a] p-4">
                    <p className="text-[18px] font-semibold text-[#f2e7da]">Capabilities Missing Assignments</p>
                    <p className="mt-2 text-[28px] font-black text-[#d4a574]">{missingAssignments.length}</p>
                  </div>
                  <div className="border border-[#2d2d2d] bg-[#1a1a1a] p-4">
                    <p className="text-[18px] font-semibold text-[#f2e7da]">Capabilities Pending Review</p>
                    <p className="mt-2 text-[28px] font-black text-[#d4a574]">{pendingReview.length}</p>
                  </div>
                  <div className="border border-[#2d2d2d] bg-[#1a1a1a] p-4">
                    <p className="text-[18px] font-semibold text-[#f2e7da]">Capabilities Marked Draft</p>
                    <p className="mt-2 text-[28px] font-black text-[#d4a574]">{draftCapabilities.length}</p>
                  </div>
                </div>
              </article>

              <article className="border border-[#8b4444] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">FRONT-END TRACK ASSIGNMENT PREVIEW</h2>
                <p className="mt-2 text-[14px] leading-6 text-[#bfb3a6]">
                  Active Track Assignments are displayed here in preview mode for capability planning and role exposure checks.
                </p>
                <div className="mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]" htmlFor="athleteProfile">
                      Active athlete profile
                    </label>
                    <select
                      id="athleteProfile"
                      value={selectedAthleteId}
                      onChange={(event) => setSelectedAthleteId(event.target.value)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    >
                      {athleteProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                    {allTrackIds.map((trackId) => {
                      const assigned = assignedTracks.includes(trackId);
                      return (
                        <button
                          key={trackId}
                          type="button"
                          onClick={() => toggleTrackAssignment(trackId)}
                          className={`grid gap-2 border px-4 py-4 text-left ${
                            assigned
                              ? 'border-[#8b4444] bg-[#351717] text-[#f2e7da]'
                              : 'border-[#2d2d2d] bg-[#1a1a1a] text-[#cfbfae]'
                          }`}
                        >
                          <span className="text-[18px] font-semibold">{trackManifests[trackId].name}</span>
                          <span className="text-[14px]">Assigned Capabilities: {TRACK_CAPABILITY_PREVIEW[trackId].length} preview mapped</span>
                          <span className="text-[14px]">Assigned Roles: Athlete / Coach</span>
                          <span className="text-[14px]">Status: {assigned ? 'Assigned' : 'Unassigned'}</span>
                          <span className="text-[14px]">Review Needed: {assigned ? 'No' : 'Yes'}</span>
                          <span className="text-[14px] text-[#b9ab9d]">{TRACK_CAPABILITY_PREVIEW[trackId].join(', ')}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </article>
            </section>
          )}

          {activeTab === 'library' && (
            <section className="space-y-5">
              <article className="border border-[#3a3a3a] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">Capability Library</h2>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <input
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      logTrace('capability searched', event.target.value || '(cleared)');
                    }}
                    placeholder="SEARCH CAPABILITIES"
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  />

                  <select
                    value={filterRole}
                    onChange={(event) => {
                      setFilterRole(event.target.value as 'ALL' | RoleName);
                      logTrace('filter changed', `Role: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    <option value="ALL">Role: ALL</option>
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        Role: {role}
                      </option>
                    ))}
                  </select>

                  <select
                    value={filterCategory}
                    onChange={(event) => {
                      setFilterCategory(event.target.value);
                      logTrace('filter changed', `Category: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>
                        Category: {category}
                      </option>
                    ))}
                  </select>

                  <select
                    value={filterStatus}
                    onChange={(event) => {
                      setFilterStatus(event.target.value as 'ALL' | CapabilityStatus);
                      logTrace('filter changed', `Status: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    <option value="ALL">Status: ALL</option>
                    <option value="DRAFT">Status: DRAFT</option>
                    <option value="ACTIVE">Status: ACTIVE</option>
                    <option value="BLOCKED">Status: BLOCKED</option>
                    <option value="ARCHIVED">Status: ARCHIVED</option>
                  </select>

                  <select
                    value={filterOwner}
                    onChange={(event) => {
                      setFilterOwner(event.target.value);
                      logTrace('filter changed', `Owner: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    {ownerOptions.map((owner) => (
                      <option key={owner} value={owner}>
                        Owner: {owner}
                      </option>
                    ))}
                  </select>

                  <select
                    value={filterVisibility}
                    onChange={(event) => {
                      setFilterVisibility(event.target.value as 'ALL' | CapabilityVisibility);
                      logTrace('filter changed', `Visibility: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    <option value="ALL">Visibility: ALL</option>
                    <option value="Internal">Visibility: Internal</option>
                    <option value="Role-Bound">Visibility: Role-Bound</option>
                    <option value="Public Placeholder">Visibility: Public Placeholder</option>
                  </select>

                  <select
                    value={filterAssignment}
                    onChange={(event) => {
                      setFilterAssignment(event.target.value as AssignmentFilter);
                      logTrace('filter changed', `Assignment: ${event.target.value}`);
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                  >
                    <option value="all">Assigned/Unassigned: ALL</option>
                    <option value="assigned">Assigned only</option>
                    <option value="unassigned">Unassigned only</option>
                  </select>
                </div>
              </article>

              <article className="border border-[#3a3a3a] bg-[#141414] p-0">
                <div className="divide-y divide-[#2a2a2a] lg:hidden">
                  {filteredCapabilities.map((capability) => {
                    const expanded = expandedCapabilityId === capability.id;
                    const assignmentFocused = assignmentFocusId === capability.id;
                    return (
                      <div key={capability.id} className="space-y-3 px-4 py-4">
                        <div className="space-y-2">
                          <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-[#d4a574]">{capability.capabilityId}</p>
                          <h3 className="text-[18px] font-bold text-[#f2e7da]">{capability.name}</h3>
                          <p className="text-[14px] text-[#bfb3a6]">Last updated: {formatDateLabel(capability.updatedAt)}</p>
                          <p className="text-[14px] text-[#cfbfae]">Category: {capability.group}</p>
                          <p className="text-[14px] text-[#cfbfae]">Roles: {capability.assignedRoles.length > 0 ? capability.assignedRoles.join(', ') : 'Unassigned'}</p>
                          <p className="text-[14px] text-[#cfbfae]">Status: {capability.status} | Visibility: {capability.visibility}</p>
                          <p className="text-[14px] text-[#cfbfae]">Owner: {capability.owner}</p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedCapabilityId(expanded ? null : capability.id);
                              logTrace('capability viewed', capability.capabilityId);
                            }}
                            className="h-11 border border-[#3a3a3a] bg-[#1c1c1c] px-3 text-[12px] font-bold text-[#cfbfae]"
                          >
                            VIEW
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEdit(capability)}
                            className="h-11 border border-[#3a3a3a] bg-[#1c1c1c] px-3 text-[12px] font-bold text-[#cfbfae]"
                          >
                            EDIT
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedCapabilityId(capability.id);
                              setAssignmentFocusId(capability.id);
                              logTrace('capability assigned', `Open assignment panel for ${capability.capabilityId}`);
                            }}
                            className="h-11 border border-[#8b4444] bg-[#2e1717] px-3 text-[12px] font-bold text-[#f2e7da]"
                          >
                            ASSIGN
                          </button>
                          <button
                            type="button"
                            onClick={() => setCapabilityStatus(capability.id, 'ARCHIVED')}
                            className="h-11 border border-[#8b4444] bg-[#3a1414] px-3 text-[12px] font-bold text-[#f2e7da]"
                          >
                            ARCHIVE
                          </button>
                        </div>

                        {expanded && (
                          <div className="border border-[#2a2a2a] bg-[#111111] px-4 py-4">
                            <p className="text-[16px] text-[#cfbfae]">{capability.description}</p>
                            <p className="mt-2 text-[14px] text-[#b9ab9d]">Dependencies: {capability.dependencies || 'None listed'}</p>
                            <p className="mt-1 text-[14px] text-[#b9ab9d]">Notes: {capability.notes || 'No additional notes'}</p>

                            {assignmentFocused && (
                              <div className="mt-4 space-y-2">
                                <p className="text-[14px] font-semibold uppercase tracking-[0.12em] text-[#d4a574]">Role Assignment Controls</p>
                                <div className="flex flex-wrap gap-2">
                                  {ROLE_OPTIONS.map((role) => {
                                    const assigned = capability.assignedRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        type="button"
                                        onClick={() => toggleCapabilityRole(capability.id, role)}
                                        className={`h-11 border px-3 text-[13px] font-bold ${
                                          assigned
                                            ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                                            : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae]'
                                        }`}
                                      >
                                        {assigned ? '✓ ' : '— '}
                                        {role}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'DRAFT')}
                                className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-3 text-[13px] font-bold text-[#cfbfae]"
                              >
                                SET DRAFT
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'ACTIVE')}
                                className="h-11 border border-[#8b4444] bg-[#5a2a2a] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                SET ACTIVE
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'BLOCKED')}
                                className="h-11 border border-[#8b4444] bg-[#3a1414] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                SET BLOCKED
                              </button>
                              <button
                                type="button"
                                onClick={() => removeCapability(capability.id)}
                                className="h-11 border border-[#8b4444] bg-[#2b1010] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                DELETE
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="hidden overflow-x-auto lg:block">
                  <div className="min-w-[1260px]">
                    <div className="grid grid-cols-[100px_minmax(200px,1.3fr)_minmax(160px,1fr)_minmax(150px,1fr)_120px_130px_150px_170px] gap-2 border-b border-[#3a3a3a] bg-[#181818] px-4 py-3 text-[14px] font-semibold text-[#cfbfae]">
                      <span>ID</span>
                      <span>Capability</span>
                      <span>Category</span>
                      <span>Assigned Role(s)</span>
                      <span>Status</span>
                      <span>Visibility</span>
                      <span>Owner</span>
                      <span>Actions</span>
                    </div>

                    <div className="divide-y divide-[#2a2a2a]">
                  {filteredCapabilities.map((capability) => {
                    const expanded = expandedCapabilityId === capability.id;
                    const assignmentFocused = assignmentFocusId === capability.id;
                    return (
                      <div key={capability.id} className="bg-[#141414]">
                        <div className="grid grid-cols-[100px_minmax(200px,1.3fr)_minmax(160px,1fr)_minmax(150px,1fr)_120px_130px_150px_170px] gap-2 px-4 py-3 text-[14px] text-[#f2e7da]">
                          <span>{capability.capabilityId}</span>
                          <span>
                            <strong className="block text-[16px]">{capability.name}</strong>
                            <span className="text-[14px] text-[#bfb3a6]">Last updated: {formatDateLabel(capability.updatedAt)}</span>
                          </span>
                          <span>{capability.group}</span>
                          <span>{capability.assignedRoles.length > 0 ? capability.assignedRoles.join(', ') : 'Unassigned'}</span>
                          <span>{capability.status}</span>
                          <span>{capability.visibility}</span>
                          <span>{capability.owner}</span>
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedCapabilityId(expanded ? null : capability.id);
                                logTrace('capability viewed', capability.capabilityId);
                              }}
                              className="h-11 border border-[#3a3a3a] bg-[#1c1c1c] px-2 text-[12px] font-bold text-[#cfbfae]"
                            >
                              VIEW
                            </button>
                            <button
                              type="button"
                              onClick={() => beginEdit(capability)}
                              className="h-11 border border-[#3a3a3a] bg-[#1c1c1c] px-2 text-[12px] font-bold text-[#cfbfae]"
                            >
                              EDIT
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedCapabilityId(capability.id);
                                setAssignmentFocusId(capability.id);
                                logTrace('capability assigned', `Open assignment panel for ${capability.capabilityId}`);
                              }}
                              className="h-11 border border-[#8b4444] bg-[#2e1717] px-2 text-[12px] font-bold text-[#f2e7da]"
                            >
                              ASSIGN
                            </button>
                            <button
                              type="button"
                              onClick={() => setCapabilityStatus(capability.id, 'ARCHIVED')}
                              className="h-11 border border-[#8b4444] bg-[#3a1414] px-2 text-[12px] font-bold text-[#f2e7da]"
                            >
                              ARCHIVE
                            </button>
                          </div>
                        </div>

                        {expanded && (
                          <div className="border-t border-[#2a2a2a] bg-[#111111] px-4 py-4">
                            <p className="text-[16px] text-[#cfbfae]">{capability.description}</p>
                            <p className="mt-2 text-[14px] text-[#b9ab9d]">Dependencies: {capability.dependencies || 'None listed'}</p>
                            <p className="mt-1 text-[14px] text-[#b9ab9d]">Notes: {capability.notes || 'No additional notes'}</p>

                            {assignmentFocused && (
                              <div className="mt-4 space-y-2">
                                <p className="text-[14px] font-semibold uppercase tracking-[0.12em] text-[#d4a574]">Role Assignment Controls</p>
                                <div className="flex flex-wrap gap-2">
                                  {ROLE_OPTIONS.map((role) => {
                                    const assigned = capability.assignedRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        type="button"
                                        onClick={() => toggleCapabilityRole(capability.id, role)}
                                        className={`h-11 border px-3 text-[13px] font-bold ${
                                          assigned
                                            ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                                            : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae]'
                                        }`}
                                      >
                                        {assigned ? '✓ ' : '— '}
                                        {role}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'DRAFT')}
                                className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-3 text-[13px] font-bold text-[#cfbfae]"
                              >
                                SET DRAFT
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'ACTIVE')}
                                className="h-11 border border-[#8b4444] bg-[#5a2a2a] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                SET ACTIVE
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'BLOCKED')}
                                className="h-11 border border-[#8b4444] bg-[#3a1414] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                SET BLOCKED
                              </button>
                              <button
                                type="button"
                                onClick={() => removeCapability(capability.id)}
                                className="h-11 border border-[#8b4444] bg-[#2b1010] px-3 text-[13px] font-bold text-[#f2e7da]"
                              >
                                DELETE
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                    </div>
                  </div>
                </div>
              </article>
            </section>
          )}

          {activeTab === 'matrix' && (
            <section className="space-y-5">
              <article className="border border-[#3a3a3a] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">Assignment Matrix</h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {[
                    { id: 'all', label: 'Show All' },
                    { id: 'unassigned', label: 'Show Only Unassigned' },
                    { id: 'multi-role', label: 'Show Only Multi-Role' },
                    { id: 'draft', label: 'Show Only Draft' },
                    { id: 'active', label: 'Show Only Active' },
                  ].map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setMatrixFilter(option.id as MatrixFilter);
                        logTrace('filter changed', `Matrix filter: ${option.label}`);
                      }}
                      className={`h-11 border px-4 text-[14px] font-bold ${
                        matrixFilter === option.id
                          ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                          : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae]'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </article>

              <article className="overflow-x-auto border border-[#3a3a3a] bg-[#141414]">
                <table className="min-w-[1300px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[#3a3a3a] bg-[#181818] text-[14px] uppercase tracking-[0.08em] text-[#cfbfae]">
                      <th className="px-4 py-3">Capability</th>
                      {ROLE_OPTIONS.map((role) => (
                        <th key={role} className="px-3 py-3">
                          {role}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrixCapabilities.map((capability) => (
                      <tr key={capability.id} className="border-b border-[#2a2a2a] text-[14px] text-[#f2e7da]">
                        <td className="px-4 py-3">
                          <p className="text-[16px] font-semibold">{capability.capabilityId} - {capability.name}</p>
                          <p className="text-[14px] text-[#bfb3a6]">{capability.group} • {capability.status}</p>
                        </td>
                        {ROLE_OPTIONS.map((role) => {
                          const assigned = capability.assignedRoles.includes(role);
                          const needsReview = assigned && capability.status === 'DRAFT';
                          return (
                            <td key={role} className="px-3 py-3">
                              <button
                                type="button"
                                onClick={() => toggleCapabilityRole(capability.id, role)}
                                className={`h-11 min-w-[90px] border px-2 text-[13px] font-bold ${
                                  needsReview
                                    ? 'border-[#8b4444] bg-[#3a1414] text-[#f2e7da]'
                                    : assigned
                                      ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                                      : 'border-[#2d2d2d] bg-[#1a1a1a] text-[#cfbfae]'
                                }`}
                              >
                                {needsReview ? '⚠' : assigned ? '✓' : '—'}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            </section>
          )}

          {activeTab === 'builder' && (
            <section className="space-y-5">
              <article className="border border-[#8b4444] bg-[#141414] p-6">
                <h2 className="text-[20px] font-bold text-[#f2e7da]">Capability Builder</h2>
                <p className="mt-2 text-[14px] leading-6 text-[#bfb3a6]">
                  Create and manage capability definitions without leaving the Admin Console.
                </p>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Capability Name</label>
                    <input
                      value={builderName}
                      onChange={(event) => setBuilderName(event.target.value)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Capability ID</label>
                    <input
                      value={builderCapabilityId}
                      onChange={(event) => setBuilderCapabilityId(event.target.value)}
                      placeholder="CAP-###"
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Category</label>
                    <input
                      value={builderCategory}
                      onChange={(event) => setBuilderCategory(event.target.value)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Owner / Steward</label>
                    <input
                      value={builderOwner}
                      onChange={(event) => setBuilderOwner(event.target.value)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div className="lg:col-span-2">
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Description</label>
                    <textarea
                      value={builderDescription}
                      onChange={(event) => setBuilderDescription(event.target.value)}
                      className="min-h-[110px] w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 py-2 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Primary Role</label>
                    <select
                      value={builderPrimaryRole}
                      onChange={(event) => setBuilderPrimaryRole(event.target.value as RoleName)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Status</label>
                    <select
                      value={builderStatus}
                      onChange={(event) => setBuilderStatus(event.target.value as CapabilityStatus)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    >
                      <option value="DRAFT">Draft</option>
                      <option value="ACTIVE">Active</option>
                      <option value="BLOCKED">Blocked</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Visibility</label>
                    <select
                      value={builderVisibility}
                      onChange={(event) => setBuilderVisibility(event.target.value as CapabilityVisibility)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    >
                      <option value="Internal">Internal</option>
                      <option value="Role-Bound">Role-Bound</option>
                      <option value="Public Placeholder">Public Placeholder</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Dependencies</label>
                    <input
                      value={builderDependencies}
                      onChange={(event) => setBuilderDependencies(event.target.value)}
                      className="h-11 w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 text-[16px] text-[#f2e7da]"
                    />
                  </div>

                  <div className="lg:col-span-2">
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Secondary Roles</label>
                    <div className="flex flex-wrap gap-2">
                      {ROLE_OPTIONS.filter((role) => role !== builderPrimaryRole).map((role) => {
                        const selected = builderSecondaryRoles.includes(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            onClick={() => toggleSecondaryRole(role)}
                            className={`h-11 border px-3 text-[13px] font-bold ${
                              selected
                                ? 'border-[#8b4444] bg-[#5a2a2a] text-[#f2e7da]'
                                : 'border-[#3a3a3a] bg-[#1a1a1a] text-[#cfbfae]'
                            }`}
                          >
                            {selected ? '✓ ' : ''}
                            {role}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="lg:col-span-2">
                    <label className="mb-2 block text-[14px] font-semibold text-[#cfbfae]">Notes</label>
                    <textarea
                      value={builderNotes}
                      onChange={(event) => setBuilderNotes(event.target.value)}
                      className="min-h-[90px] w-full border border-[#3a3a3a] bg-[#0f0f0f] px-3 py-2 text-[16px] text-[#f2e7da]"
                    />
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={saveCapability}
                    className="h-11 border border-[#8b4444] bg-[#5a2a2a] px-4 text-[14px] font-bold text-[#f2e7da]"
                  >
                    SAVE CAPABILITY
                  </button>
                  <button
                    type="button"
                    onClick={resetBuilder}
                    className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-4 text-[14px] font-bold text-[#cfbfae]"
                  >
                    RESET FORM
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetBuilder();
                      setActiveTab('library');
                    }}
                    className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-4 text-[14px] font-bold text-[#cfbfae]"
                  >
                    CANCEL
                  </button>
                </div>
              </article>
            </section>
          )}

          <section className="border border-[#3a3a3a] bg-[#141414] p-4">
            <button
              type="button"
              onClick={() => setShowTelemetry((current) => !current)}
              className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-4 text-[14px] font-bold text-[#cfbfae]"
            >
              {showTelemetry ? 'Hide' : 'Show'} local event traces
            </button>

            {showTelemetry && (
              <div className="mt-3 max-h-[220px] overflow-y-auto border border-[#2d2d2d] bg-[#111111]">
                {eventTraces.length === 0 && <p className="px-4 py-3 text-[14px] text-[#b9ab9d]">No traces yet.</p>}
                {eventTraces.map((trace, index) => (
                  <div key={`${trace.timestamp}-${index}`} className="border-b border-[#232323] px-4 py-3 text-[14px] text-[#b9ab9d]">
                    <span className="font-mono text-[#d4a574]">[{trace.timestamp}]</span> {trace.action} - {trace.detail}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowIntegrationStubs((current) => !current)}
                className="h-11 border border-[#3a3a3a] bg-[#1a1a1a] px-4 text-[14px] font-bold text-[#cfbfae]"
              >
                {showIntegrationStubs ? 'Hide' : 'Show'} backend integration stubs
              </button>

              {showIntegrationStubs && (
                <div className="mt-3 border border-[#2d2d2d] bg-[#111111]">
                  {INTEGRATION_STUBS.map((item) => (
                    <div key={item} className="border-b border-[#232323] px-4 py-3 text-[14px] text-[#b9ab9d] last:border-b-0">
                      {item}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </RoleSessionGate>
  );
}
