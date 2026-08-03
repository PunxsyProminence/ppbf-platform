'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import RevenueFundingCenter from '@/components/RevenueFundingCenter';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import ShadowChatButton from '@/components/ShadowChatButton';
import { apiBase } from '@/lib/apiBase';
import {
  allTrackIds,
  athleteProfiles,
  getDefaultTrackAssignments,
  normalizeTrackAssignments,
  trackManifests,
  type TrackAssignments,
  type TrackID,
} from '@/components/trackAssignments';

type CapabilityStatus = 'DRAFT' | 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';
type CapabilityVisibility = 'Internal' | 'Role-Bound' | 'Public Placeholder';
type TabKey = 'overview' | 'library' | 'matrix' | 'builder' | 'revenue';
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

const seedCapabilityBlueprints: Array<{ capabilityId: string; name: string; group: string; status: CapabilityStatus; owner: string; roles: RoleName[]; description: string }> = [
  {
    capabilityId: 'CAP-001',
    name: 'Locker Rooms for Every Role',
    group: 'Core Platform',
    status: 'DRAFT',
    owner: 'Operations',
    roles: ['Athlete', 'Coach', 'Admin'],
    description: 'Role-based locker room entry points and contextual dashboards.',
  },
  {
    capabilityId: 'CAP-002',
    name: 'The Card File',
    group: 'Core Platform',
    status: 'ACTIVE',
    owner: 'Admin Control',
    roles: ['Admin', 'Board', 'Auditor'],
    description: 'Capability catalog and governance metadata index.',
  },
  {
    capabilityId: 'CAP-003',
    name: 'Map Your Fight',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Athlete', 'Coach'],
    description: 'Route guidance and mission-control view alignment.',
  },
  {
    capabilityId: 'CAP-004',
    name: 'Goal Intake and Routing Service',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Athlete', 'Coach', 'Admin'],
    description: 'Maps intake goals to the correct training or support route.',
  },
  {
    capabilityId: 'CAP-005',
    name: 'Development Route Factory',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Coach', 'Admin'],
    description: 'Builds route templates for progression, recovery, and competition paths.',
  },
  {
    capabilityId: 'CAP-006',
    name: 'Session Logging Service',
    group: 'Program Operations',
    status: 'ACTIVE',
    owner: 'Operations',
    roles: ['Athlete', 'Coach', 'Admin'],
    description: 'Captures execution notes and session outcomes for daily operations.',
  },
  {
    capabilityId: 'CAP-007',
    name: 'Safety Gate Matrix',
    group: 'Safety & Compliance',
    status: 'ACTIVE',
    owner: 'Safety Office',
    roles: ['Coach', 'Safety', 'Admin'],
    description: 'Evaluates risk signals and enforces progression boundaries.',
  },
  {
    capabilityId: 'CAP-008',
    name: 'Athlete Self-Service Portal',
    group: 'Core Platform',
    status: 'ACTIVE',
    owner: 'Operations',
    roles: ['Athlete'],
    description: 'Athlete-facing goals, readiness, check-ins, and daily tasks.',
  },
  {
    capabilityId: 'CAP-009',
    name: 'Guardian Portal',
    group: 'Core Platform',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Parent / Guardian', 'Admin'],
    description: 'Family communication, progress visibility, and support workflows.',
  },
  {
    capabilityId: 'CAP-010',
    name: 'Public Portal',
    group: 'Core Platform',
    status: 'ACTIVE',
    owner: 'Operations',
    roles: ['Public', 'Admin'],
    description: 'Public-facing storytelling, onboarding, and safe access routes.',
  },
  {
    capabilityId: 'CAP-011',
    name: 'Grant and Impact Reporting Engine',
    group: 'Program Operations',
    status: 'DRAFT',
    owner: 'Board Office',
    roles: ['Board', 'Admin', 'Auditor'],
    description: 'Compiles outcomes and evidence trails for grants and governance.',
  },
  {
    capabilityId: 'CAP-012',
    name: 'Payment Service (Gated)',
    group: 'Program Operations',
    status: 'BLOCKED',
    owner: 'Admin Control',
    roles: ['Admin', 'Board'],
    description: 'Reserved payment lane covering donations, recurring giving, class fees, and B2B wholesale invoicing — scope and integration contract in docs/PAYMENT_SERVICE_SLOT.md; blocked pending backend and compliance sign-off.',
  },
  {
    capabilityId: 'CAP-013',
    name: 'Continuity Ledger and Digital Operating Map',
    group: 'Program Operations',
    status: 'DRAFT',
    owner: 'Board Office',
    roles: ['Admin', 'Board', 'Auditor'],
    description: 'Tracks evolution of systems, controls, and platform continuity.',
  },
  {
    capabilityId: 'SHADOW-CHAT-001',
    name: 'SHADOW Chats Command Surface',
    group: 'Core Platform',
    status: 'ACTIVE',
    owner: 'Admin Control',
    roles: ['Athlete', 'Coach', 'Admin', 'Board'],
    description: 'Role-scoped SHADOW conversational command surface for guided operations.',
  },
  {
    capabilityId: 'SHADOW-AI-001',
    name: 'SHADOW AI Assistance Layer',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Coach', 'Admin', 'Safety'],
    description: 'AI-assisted recommendations with explicit human approval guardrails.',
  },
  {
    capabilityId: 'SHADOW-ML-001',
    name: 'SHADOW ML Readiness Analysis',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Safety Office',
    roles: ['Coach', 'Safety', 'Admin'],
    description: 'Model-backed readiness pattern detection for safer assignment decisions.',
  },
  {
    capabilityId: 'SHADOW-ML-002',
    name: 'SHADOW Video Analysis Intelligence',
    group: 'Routing & Development',
    status: 'DRAFT',
    owner: 'Program Team',
    roles: ['Coach', 'Admin'],
    description: 'Planned AI/ML video signal support for technique and safety review workflows.',
  },
  {
    capabilityId: 'SAFE-001',
    name: 'Compliance Violation Escalation Center',
    group: 'Safety & Compliance',
    status: 'ACTIVE',
    owner: 'Safety Office',
    roles: ['Safety', 'Admin', 'Board'],
    description: 'Tracks violation states, escalations, and resolution workflow history.',
  },
  {
    capabilityId: 'OPS-001',
    name: 'Mission Control Operations Hub',
    group: 'Program Operations',
    status: 'ACTIVE',
    owner: 'Operations',
    roles: ['Admin', 'Coach', 'Board'],
    description: 'Command view for daily priorities, workspace routing, and system posture.',
  },
  {
    capabilityId: 'REV-001',
    name: 'Revenue and Funding Center',
    group: 'Program Operations',
    status: 'ACTIVE',
    owner: 'Board Office',
    roles: ['Admin', 'Board', 'Auditor'],
    description: 'Revenue operations and funding workflow orchestration center.',
  },
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

const TAB_KEY_SET = new Set<TabKey>(['overview', 'library', 'matrix', 'builder', 'revenue']);

function parseTabKey(raw: string | null): TabKey | null {
  if (!raw) {
    return null;
  }

  return TAB_KEY_SET.has(raw as TabKey) ? (raw as TabKey) : null;
}

const fallbackCapabilities: Capability[] = seedCapabilityBlueprints.map((item, index) => {
  const nowIso = new Date().toISOString();
  return {
    id: index + 1,
    capabilityId: item.capabilityId,
    name: item.name,
    group: item.group,
    status: item.status,
    visibility: item.capabilityId.startsWith('SHADOW-') ? 'Internal' : 'Role-Bound',
    owner: item.owner,
    assignedRoles: item.roles,
    description: item.description,
    dependencies: '',
    notes: '',
    reviewNeeded: item.status === 'DRAFT',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
});

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

function withFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function toCapabilityId(raw: unknown, index: number): string {
  return withFallback(raw, `CAP-${String(index + 1).padStart(3, '0')}`);
}

function toVisibility(raw: unknown): CapabilityVisibility {
  if (raw === 'Internal' || raw === 'Role-Bound' || raw === 'Public Placeholder') {
    return raw;
  }
  return 'Role-Bound';
}

function toIsoDate(raw: unknown, fallbackIso: string): string {
  return typeof raw === 'string' ? raw : fallbackIso;
}

function hydrateCapability(source: Partial<Capability>, index: number): Capability {
  const nowIso = new Date().toISOString();
  const capabilityName = withFallback(source.name, `Capability ${index + 1}`);
  const status = toCapabilityStatus(source.status);
  const assignedRoles = toRoleList(source.assignedRoles);
  return {
    id: typeof source.id === 'number' ? source.id : index + 1,
    capabilityId: toCapabilityId(source.capabilityId, index),
    name: capabilityName,
    group: withFallback(source.group, 'General'),
    status,
    visibility: toVisibility(source.visibility),
    owner: withFallback(source.owner, 'Operations'),
    assignedRoles,
    description: withFallback(source.description, `${capabilityName} capability definition pending detailed admin notes.`),
    dependencies: typeof source.dependencies === 'string' ? source.dependencies : '',
    notes: typeof source.notes === 'string' ? source.notes : '',
    reviewNeeded: typeof source.reviewNeeded === 'boolean' ? source.reviewNeeded : status === 'DRAFT',
    createdAt: toIsoDate(source.createdAt, nowIso),
    updatedAt: toIsoDate(source.updatedAt, nowIso),
  };
}

async function readResponseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || fallback;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }
  return date.toLocaleDateString();
}

export default function AdminCapabilitiesPage() {
  const pilotSession = usePilotSession();
  // The People console is organization-scoped; every route behind it rejects a
  // platform owner. Showing the entry point to someone who can only receive a
  // 403 from it is worse than not showing it at all -- they get Organization
  // Provisioning instead, which is the surface that actually does their job.
  const canManagePeople = isOrganizationAdminSessionRole(pilotSession.role);
  // Same boundary as the People console: every compliance route is
  // organization-scoped and refuses a platform owner, so the entry point would
  // only lead to a 403.
  const canOpenComplianceCenter = isOrganizationAdminSessionRole(pilotSession.role);
  const [capabilities, setCapabilities] = useState<Capability[]>(fallbackCapabilities);
  const [capabilitiesHydrated, setCapabilitiesHydrated] = useState(false);
  const [trackAssignmentsHydrated, setTrackAssignmentsHydrated] = useState(false);
  const [gymCapabilityHydrated, setGymCapabilityHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === 'undefined') {
      return 'overview';
    }

    return parseTabKey(new URLSearchParams(window.location.search).get('tab')) ?? 'overview';
  });
  const [selectedAthleteId, setSelectedAthleteId] = useState(athleteProfiles[0].id);
  const [trackAssignments, setTrackAssignments] = useState<TrackAssignments>(() => getDefaultTrackAssignments());

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
  const [gymCapabilityAccess, setGymCapabilityAccess] = useState<Record<string, boolean>>({});
  const [capabilityStoreError, setCapabilityStoreError] = useState('');
  const [gymCapabilityStoreError, setGymCapabilityStoreError] = useState('');

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
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/track-assignments`, {
          method: 'GET',
          credentials: 'include',
        });

        if (!response.ok) {
          setTrackAssignmentsHydrated(true);
          return;
        }

        const payload = (await response.json()) as { assignments?: unknown };
        setTrackAssignments(normalizeTrackAssignments(payload.assignments));
      } catch {
        // Keep default track assignments if backend load fails.
      } finally {
        setTrackAssignmentsHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!trackAssignmentsHydrated) {
      return;
    }

    void fetch(`${apiBase()}/api/pilot/admin/track-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ assignments: trackAssignments }),
    });
  }, [trackAssignments, trackAssignmentsHydrated]);

  // The hydrated flags are what release the save effects below, so they stay
  // false whenever a load fails: saving the on-screen seed over a record that
  // was never read would destroy the stored registry.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/capabilities`, {
          method: 'GET',
          credentials: 'include',
        });

        if (!response.ok) {
          setCapabilityStoreError(
            `${await readResponseError(response, 'Capability registry could not be loaded')}. The list below is a starting template and capability edits are not being saved.`,
          );
          return;
        }

        const payload = (await response.json()) as { capabilities?: Partial<Capability>[] };
        if (Array.isArray(payload.capabilities) && payload.capabilities.length > 0) {
          // A stored registry is authoritative and is shown exactly as stored.
          // The seed blueprints used to be merged in here, which made archiving
          // impossible: a capability an administrator removed was added back on
          // the next load and then written to the registry by the save effect
          // below, so the record drifted toward the template no matter what the
          // gym decided. The seeds remain the starting point for a gym that has
          // no registry yet -- that is the initial state at `useState`, not this.
          setCapabilities(payload.capabilities.map((item, index) => hydrateCapability(item, index)));
        }
        setCapabilitiesHydrated(true);
      } catch (error) {
        setCapabilityStoreError(
          `${toErrorMessage(error, 'Capability registry could not be loaded')}. The list below is a starting template and capability edits are not being saved.`,
        );
      }
    })();
  }, []);

  useEffect(() => {
    if (!capabilitiesHydrated) {
      return;
    }

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/capabilities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ capabilities }),
        });

        if (!response.ok) {
          setCapabilityStoreError(
            `${await readResponseError(response, 'Capability registry could not be saved')}. This change is not saved and will be lost on reload.`,
          );
          return;
        }

        setCapabilityStoreError('');
      } catch (error) {
        setCapabilityStoreError(
          `${toErrorMessage(error, 'Capability registry could not be saved')}. This change is not saved and will be lost on reload.`,
        );
      }
    })();
  }, [capabilities, capabilitiesHydrated]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/gym-capabilities`, {
          method: 'GET',
          credentials: 'include',
        });

        if (!response.ok) {
          setGymCapabilityStoreError(
            `${await readResponseError(response, 'Gym capability access could not be loaded')}. Gym admin access changes are not being saved.`,
          );
          return;
        }

        const payload = (await response.json()) as { capabilityAccess?: Record<string, boolean> };
        setGymCapabilityAccess(payload.capabilityAccess || {});
        setGymCapabilityHydrated(true);
      } catch (error) {
        setGymCapabilityStoreError(
          `${toErrorMessage(error, 'Gym capability access could not be loaded')}. Gym admin access changes are not being saved.`,
        );
      }
    })();
  }, []);

  useEffect(() => {
    if (!gymCapabilityHydrated) {
      return;
    }

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/admin/gym-capabilities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ capabilityAccess: gymCapabilityAccess }),
        });

        if (!response.ok) {
          setGymCapabilityStoreError(
            `${await readResponseError(response, 'Gym capability access could not be saved')}. This change is not saved and will be lost on reload.`,
          );
          return;
        }

        setGymCapabilityStoreError('');
      } catch (error) {
        setGymCapabilityStoreError(
          `${toErrorMessage(error, 'Gym capability access could not be saved')}. This change is not saved and will be lost on reload.`,
        );
      }
    })();
  }, [gymCapabilityAccess, gymCapabilityHydrated]);

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

  const switchboardCapabilities = useMemo(() => capabilities.filter((item) => item.status !== 'ARCHIVED'), [capabilities]);

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

  function toggleGymCapabilityAccess(capabilityId: string) {
    setGymCapabilityAccess((current) => ({
      ...current,
      [capabilityId]: !current[capabilityId],
    }));
    logTrace('gym capability toggled', `${capabilityId} -> ${gymCapabilityAccess[capabilityId] ? 'OFF' : 'ON'}`);
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
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <header className="border-b-4 border-[color:var(--brass-700)] bg-[var(--hide-900)] px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-[length:var(--t-xs)] font-mono uppercase tracking-[0.16em] text-[color:var(--brass-300)]">PPBF ADMIN AUTHORITY CONSOLE</p>
              <h1 className="mt-2 font-display text-[length:var(--t-xl)] font-black tracking-tight text-[color:var(--bone-100)]">Capability Management Console</h1>
              <p className="mt-2 max-w-4xl text-[length:var(--t-sm)] leading-7 text-[color:var(--bone-300)]">
                Control capability definitions, assignments, status, and role exposure across the PPBF ecosystem.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <ShadowChatButton context="Admin Hub" />
              {canManagePeople && (
                <Link
                  href="/admin/people"
                  className="btn"
                >
                  PEOPLE
                </Link>
              )}
              <Link
                href="/admin/shadow"
                className="btn"
              >
                SHADOW
              </Link>
              {/*
                Video upload lives on a COACH page, and an organization_admin
                lands here -- so the only surface that calls
                POST /api/pilot/video/upload had no entry point for a role its
                own API admits. The owner found it the only way anyone would:
                by trying to upload a video and not finding a button.
                Gated on the same organization-admin check as PEOPLE, because
                platform_owner is refused by that API (access.ts bars Omega
                from athlete-scoped records) and a link that 403s is worse
                than no link.
              */}
              {canManagePeople && (
                <Link
                  href="/coach/video-analysis"
                  className="btn btn--ghost"
                >
                  VIDEO UPLOAD
                </Link>
              )}
              {/*
                The same defect the VIDEO UPLOAD comment above describes,
                repeated three times by the change that shipped these consoles.
                /admin/athletes, /admin/export and /coach/drills were reachable
                only by typing the URL -- no navigation anywhere in the app
                pointed at any of them.

                Two of the three are the floor-readiness surfaces: correcting an
                athlete's record before a real roster is loaded, and handing a
                family their own information back. Built for the pilot, and
                findable by nobody in it.

                Gated on the same organization-admin check for the same reason:
                every route behind them refuses platform_owner, and a link that
                403s is worse than no link.
              */}
              {canManagePeople && (
                <Link
                  href="/admin/athletes"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[var(--hide-800)]"
                >
                  ATHLETE RECORDS
                </Link>
              )}
              {canManagePeople && (
                <Link
                  href="/admin/export"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[var(--hide-800)]"
                >
                  EXPORT
                </Link>
              )}
              {canManagePeople && (
                <Link
                  href="/coach/drills"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[var(--hide-800)]"
                >
                  DRILL LIBRARY
                </Link>
              )}
              {/*
                Linked in the same change that built the screen, deliberately.
                pilot.waivers and domain-upsert both existed for months with no
                caller, and two planning documents ended up disagreeing about
                whether consent capture existed at all -- because from the
                outside, a capability with no way in is indistinguishable from
                one that was never built.
              */}
              {canManagePeople && (
                <Link
                  href="/admin/consent"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[#2a1a1a]"
                >
                  CONSENT
                </Link>
              )}
              {canManagePeople && (
                <Link
                  href="/admin/import"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[#2a1a1a]"
                >
                  LOAD ROSTER
                </Link>
              )}
              {canManagePeople && (
                <Link
                  href="/admin/gear"
                  className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-4 text-[14px] font-bold text-[color:var(--bone-100)] transition hover:bg-[#2a1a1a]"
                >
                  EQUIPMENT
                </Link>
              )}
              <Link
                href="/operations"
                className="inline-flex h-11 items-center border border-[color:var(--hide-600)] bg-[var(--hide-900)] px-4 text-[length:var(--t-sm)] font-bold text-[color:var(--bone-300)] transition hover:border-[color:var(--brass-700)]"
              >
                MISSION CONTROL
              </Link>
              {canOpenComplianceCenter && (
                <Link
                  href="/admin/compliance-center"
                  className="btn btn--ghost"
                >
                  COMPLIANCE CENTER (PLANNED)
                </Link>
              )}
              <Link
                href="/admin/organizations"
                className="btn btn--ghost"
              >
                ORGANIZATION PROVISIONING
              </Link>
              <button
                type="button"
                onClick={exportCapabilities}
                className="inline-flex h-11 items-center border border-[color:var(--brass-700)] bg-[var(--hide-950)] px-4 text-[length:var(--t-sm)] font-bold text-[color:var(--brass-300)] transition hover:border-[color:var(--brass-300)]"
              >
                EXPORT JSON
              </button>
            </div>
          </div>
        </header>

        <section className="border-b border-[color:var(--hide-600)] bg-[var(--hide-900)] px-6 py-3 text-[length:var(--t-sm)] text-[color:var(--bone-400)]">
          Capability, assignment, and gym feature changes are saved to your organization&apos;s record as you make them. Jason approval is still required for platform-wide changes.
        </section>

        {(capabilityStoreError || gymCapabilityStoreError) && (
          <section role="alert" className="border-b border-[color:var(--brass-700)] bg-[var(--rust-900)] px-6 py-3 text-[length:var(--t-sm)] text-[var(--locked-ink)]">
            {capabilityStoreError && <p>{capabilityStoreError}</p>}
            {gymCapabilityStoreError && <p className={capabilityStoreError ? 'mt-1' : undefined}>{gymCapabilityStoreError}</p>}
          </section>
        )}

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
              <article key={card.label} className="border border-[color:var(--hide-700)] bg-[var(--hide-950)] px-4 py-4">
                <p className="text-[length:var(--t-xs)] font-mono uppercase tracking-[0.16em] text-[color:var(--brass-300)]">{card.label}</p>
                <p className="mt-2 text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{card.value}</p>
              </article>
            ))}
          </section>

          <section className="flex flex-wrap gap-2 border border-[color:var(--hide-700)] bg-[var(--hide-950)] p-2">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'library', label: 'Capability Library' },
              { id: 'matrix', label: 'Assignment Matrix' },
              { id: 'builder', label: 'Capability Builder' },
              { id: 'revenue', label: 'Revenue & Funding Center' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id as TabKey);
                  logTrace('tab changed', tab.label);
                }}
                className={`h-11 border px-4 text-[length:var(--t-sm)] font-bold ${
                  activeTab === tab.id
                    ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                    : 'border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </section>

          {activeTab === 'overview' && (
            <section className="grid gap-6">
              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[length:var(--t-lg)] font-bold text-[color:var(--bone-100)]">Tutorial Access</h2>
                    <p className="t-body mt-[var(--s3)]">
                      Open the full tutorial center from this button when needed. Tutorial cards are no longer rendered inline in Admin.
                    </p>
                  </div>
                  <ShadowChatButton context="Admin Overview" />
                </div>
              </article>

              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Operational Overview</h2>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Recently Updated Capabilities</h3>
                    {recentlyUpdated.map((capability) => (
                      <div key={capability.id} className="border border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-3">
                        <p className="t-command">{capability.capabilityId} - {capability.name}</p>
                        <p className="t-muted">{capability.group} • {capability.status}</p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>Role Exposure Snapshot</h3>
                    {roleExposureSnapshot.map((item) => (
                      <div key={item.role} className="flex items-center justify-between border border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-3">
                        <p className="text-[length:var(--t-sm)] text-[color:var(--bone-100)]">{item.role}</p>
                        <p className="text-[length:var(--t-sm)] font-bold text-[color:var(--brass-300)]">{item.count}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </article>

              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Workload Buckets</h2>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-command">Capabilities Missing Assignments</p>
                    <p className="t-command--brass mt-[var(--s3)] t-command">{missingAssignments.length}</p>
                  </div>
                  <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-command">Capabilities Pending Review</p>
                    <p className="t-command--brass mt-[var(--s3)] t-command">{pendingReview.length}</p>
                  </div>
                  <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                    <p className="t-command">Capabilities Marked Draft</p>
                    <p className="t-command--brass mt-[var(--s3)] t-command">{draftCapabilities.length}</p>
                  </div>
                </div>
              </article>

              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Critical Missing Capability Front-End Surfaces</h2>
                <p className="t-body mt-[var(--s3)]">
                  PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Link href="/public" className="btn btn--ghost">
                    Edit Public Page Surface
                  </Link>
                  <Link href="/login" className="btn btn--ghost">
                    Manage Login Announcements
                  </Link>
                  {canOpenComplianceCenter && (
                    <Link href="/admin/compliance-center" className="btn btn--ghost">
                      Automated Compliance Monitoring Surface
                    </Link>
                  )}
                  <Link href="/source-control/publication-workflow" className="btn btn--ghost">
                    Automated Publication Workflow Surface
                  </Link>
                </div>
              </article>

              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Capability On/Off Switchboard</h2>
                    <p className="t-body mt-[var(--s3)]">
                      Turn platform capabilities on or off, then mirror the same access for gym admins you hand capabilities to.
                    </p>
                  </div>
                  <Link
                    href="/admin/organizations"
                    className="btn btn--ghost"
                  >
                    Open Gym Admin Provisioning
                  </Link>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <p className="t-eyebrow">Platform Control</p>
                    {switchboardCapabilities.map((capability) => {
                      const isOn = capability.status === 'ACTIVE';
                      return (
                        <div key={capability.id} className="flex items-center justify-between gap-3 border border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-3">
                          <div>
                            <p className="t-command">{capability.capabilityId} - {capability.name}</p>
                            <p className="text-[length:var(--t-xs)] text-[var(--bone-400)]">{capability.group} • {capability.status}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCapabilityStatus(capability.id, isOn ? 'BLOCKED' : 'ACTIVE')}
                            className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-[length:var(--t-xs)] font-bold uppercase tracking-[0.12em] transition ${
                              isOn
                                ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                                : 'border-[var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
                            }`}
                          >
                            {isOn ? 'On' : 'Off'}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="space-y-3">
                    <p className="t-eyebrow">Gym Admin Access</p>
                    <p className="text-[length:var(--t-sm)] leading-6 text-[var(--bone-400)]">
                      Grant a gym admin the same capability access, then let them flip it on or off inside their organization.
                    </p>
                    {switchboardCapabilities.map((capability) => {
                      const allowed = !!gymCapabilityAccess[capability.capabilityId];
                      return (
                        <div key={capability.capabilityId} className="flex items-center justify-between gap-3 border border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-3">
                          <div>
                            <p className="t-command">{capability.capabilityId}</p>
                            <p className="text-[length:var(--t-xs)] text-[var(--bone-400)]">Gym admins can {allowed ? 'toggle this capability' : 'not yet toggle this capability'}.</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleGymCapabilityAccess(capability.capabilityId)}
                            className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-[length:var(--t-xs)] font-bold uppercase tracking-[0.12em] transition ${
                              allowed
                                ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                                : 'border-[var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
                            }`}
                          >
                            {allowed ? 'Enabled' : 'Disabled'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </article>

              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>FRONT-END TRACK ASSIGNMENT PREVIEW</h2>
                <p className="t-body mt-[var(--s3)]">
                  Active Track Assignments are displayed here in preview mode for capability planning and role exposure checks.
                </p>
                <div className="mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="athleteProfile">
                      Active athlete profile
                    </label>
                    <select
                      id="athleteProfile"
                      value={selectedAthleteId}
                      onChange={(event) => setSelectedAthleteId(event.target.value)}
                      className="input"
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
                          className={`grid gap-[var(--s3)] rounded-[var(--r-md)] border px-[var(--s4)] py-[var(--s4)] text-left ${
                            assigned
                              ? 'mat-leather--raised border-[color:var(--brass-400)] bg-[rgba(212,175,74,.07)] text-[color:var(--bone-100)]'
                              : 'mat-leather border-[color:var(--hide-700)] text-[color:var(--bone-300)]'
                          }`}
                        >
                          <span className="text-[length:var(--t-md)] font-semibold">{trackManifests[trackId].name}</span>
                          <span className="text-[length:var(--t-sm)]">Assigned Capabilities: {TRACK_CAPABILITY_PREVIEW[trackId].length} preview mapped</span>
                          <span className="text-[length:var(--t-sm)]">Assigned Roles: Athlete / Coach</span>
                          <span className="text-[length:var(--t-sm)]">Status: {assigned ? 'Assigned' : 'Unassigned'}</span>
                          <span className="text-[length:var(--t-sm)]">Review Needed: {assigned ? 'No' : 'Yes'}</span>
                          <span className="t-muted">{TRACK_CAPABILITY_PREVIEW[trackId].join(', ')}</span>
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
              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Capability Library</h2>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <input
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      logTrace('capability searched', event.target.value || '(cleared)');
                    }}
                    placeholder="SEARCH CAPABILITIES"
                    className="input"
                  />

                  <select
                    value={filterRole}
                    onChange={(event) => {
                      setFilterRole(event.target.value as 'ALL' | RoleName);
                      logTrace('filter changed', `Role: ${event.target.value}`);
                    }}
                    className="input"
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
                    className="input"
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
                    className="input"
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
                    className="input"
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
                    className="input"
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
                    className="input"
                  >
                    <option value="all">Assigned/Unassigned: ALL</option>
                    <option value="assigned">Assigned only</option>
                    <option value="unassigned">Unassigned only</option>
                  </select>
                </div>
              </article>

              <article className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-0">
                <div className="divide-y divide-[var(--hide-700)] lg:hidden">
                  {filteredCapabilities.map((capability) => {
                    const expanded = expandedCapabilityId === capability.id;
                    const assignmentFocused = assignmentFocusId === capability.id;
                    return (
                      <div key={capability.id} className="space-y-3 px-4 py-4">
                        <div className="space-y-2">
                          <p className="text-[length:var(--t-xs)] font-mono uppercase tracking-[0.1em] text-[color:var(--brass-300)]">{capability.capabilityId}</p>
                          <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{capability.name}</h3>
                          <p className="t-muted">Last updated: {formatDateLabel(capability.updatedAt)}</p>
                          <p className="t-body">Category: {capability.group}</p>
                          <p className="t-body">Roles: {capability.assignedRoles.length > 0 ? capability.assignedRoles.join(', ') : 'Unassigned'}</p>
                          <p className="t-body">Status: {capability.status} | Visibility: {capability.visibility}</p>
                          <p className="t-body">Owner: {capability.owner}</p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedCapabilityId(expanded ? null : capability.id);
                              logTrace('capability viewed', capability.capabilityId);
                            }}
                            className="btn btn--ghost"
                          >
                            VIEW
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEdit(capability)}
                            className="btn btn--ghost"
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
                            className="btn btn--ghost"
                          >
                            ASSIGN
                          </button>
                          <button
                            type="button"
                            onClick={() => setCapabilityStatus(capability.id, 'ARCHIVED')}
                            className="btn btn--ghost"
                          >
                            ARCHIVE
                          </button>
                        </div>

                        {expanded && (
                          <div className="border border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-4">
                            <p className="t-body">{capability.description}</p>
                            <p className="mt-2 text-[length:var(--t-sm)] text-[var(--bone-400)]">Dependencies: {capability.dependencies || 'None listed'}</p>
                            <p className="mt-1 text-[length:var(--t-sm)] text-[var(--bone-400)]">Notes: {capability.notes || 'No additional notes'}</p>

                            {assignmentFocused && (
                              <div className="mt-4 space-y-2">
                                <p className="t-eyebrow">Role Assignment Controls</p>
                                <div className="flex flex-wrap gap-2">
                                  {ROLE_OPTIONS.map((role) => {
                                    const assigned = capability.assignedRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        type="button"
                                        onClick={() => toggleCapabilityRole(capability.id, role)}
                                        className={`h-11 border px-3 text-[length:var(--t-xs)] font-bold ${
                                          assigned
                                            ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                                            : 'border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)]'
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
                                className="btn btn--ghost"
                              >
                                SET DRAFT
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'ACTIVE')}
                                className="btn"
                              >
                                SET ACTIVE
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'BLOCKED')}
                                className="btn btn--ghost"
                              >
                                SET BLOCKED
                              </button>
                              <button
                                type="button"
                                onClick={() => removeCapability(capability.id)}
                                className="btn btn--danger"
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
                    <div className="grid grid-cols-[100px_minmax(200px,1.3fr)_minmax(160px,1fr)_minmax(150px,1fr)_120px_130px_150px_170px] gap-2 border-b border-[color:var(--hide-700)] bg-[var(--hide-900)] px-4 py-3 text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-300)]">
                      <span>ID</span>
                      <span>Capability</span>
                      <span>Category</span>
                      <span>Assigned Role(s)</span>
                      <span>Status</span>
                      <span>Visibility</span>
                      <span>Owner</span>
                      <span>Actions</span>
                    </div>

                    <div className="divide-y divide-[var(--hide-700)]">
                  {filteredCapabilities.map((capability) => {
                    const expanded = expandedCapabilityId === capability.id;
                    const assignmentFocused = assignmentFocusId === capability.id;
                    return (
                      <div key={capability.id} className="bg-[var(--hide-900)]">
                        <div className="grid grid-cols-[100px_minmax(200px,1.3fr)_minmax(160px,1fr)_minmax(150px,1fr)_120px_130px_150px_170px] gap-2 px-4 py-3 text-[length:var(--t-sm)] text-[color:var(--bone-100)]">
                          <span>{capability.capabilityId}</span>
                          <span>
                            <strong className="block text-[length:var(--t-sm)]">{capability.name}</strong>
                            <span className="t-muted">Last updated: {formatDateLabel(capability.updatedAt)}</span>
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
                              className="h-11 border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-2 text-[length:var(--t-xs)] font-bold text-[color:var(--bone-300)]"
                            >
                              VIEW
                            </button>
                            <button
                              type="button"
                              onClick={() => beginEdit(capability)}
                              className="h-11 border border-[color:var(--hide-700)] bg-[var(--hide-900)] px-2 text-[length:var(--t-xs)] font-bold text-[color:var(--bone-300)]"
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
                              className="btn btn--ghost"
                            >
                              ASSIGN
                            </button>
                            <button
                              type="button"
                              onClick={() => setCapabilityStatus(capability.id, 'ARCHIVED')}
                              className="btn btn--ghost"
                            >
                              ARCHIVE
                            </button>
                          </div>
                        </div>

                        {expanded && (
                          <div className="border-t border-[var(--hide-700)] bg-[var(--hide-900)] px-4 py-4">
                            <p className="t-body">{capability.description}</p>
                            <p className="mt-2 text-[length:var(--t-sm)] text-[var(--bone-400)]">Dependencies: {capability.dependencies || 'None listed'}</p>
                            <p className="mt-1 text-[length:var(--t-sm)] text-[var(--bone-400)]">Notes: {capability.notes || 'No additional notes'}</p>

                            {assignmentFocused && (
                              <div className="mt-4 space-y-2">
                                <p className="t-eyebrow">Role Assignment Controls</p>
                                <div className="flex flex-wrap gap-2">
                                  {ROLE_OPTIONS.map((role) => {
                                    const assigned = capability.assignedRoles.includes(role);
                                    return (
                                      <button
                                        key={role}
                                        type="button"
                                        onClick={() => toggleCapabilityRole(capability.id, role)}
                                        className={`h-11 border px-3 text-[length:var(--t-xs)] font-bold ${
                                          assigned
                                            ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                                            : 'border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)]'
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
                                className="btn btn--ghost"
                              >
                                SET DRAFT
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'ACTIVE')}
                                className="btn"
                              >
                                SET ACTIVE
                              </button>
                              <button
                                type="button"
                                onClick={() => setCapabilityStatus(capability.id, 'BLOCKED')}
                                className="btn btn--ghost"
                              >
                                SET BLOCKED
                              </button>
                              <button
                                type="button"
                                onClick={() => removeCapability(capability.id)}
                                className="btn btn--danger"
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
              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Assignment Matrix</h2>
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
                      className={`h-11 border px-4 text-[length:var(--t-sm)] font-bold ${
                        matrixFilter === option.id
                          ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                          : 'border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)]'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </article>

              <article className="overflow-x-auto border border-[color:var(--hide-700)] bg-[var(--hide-900)]">
                <table className="min-w-[1300px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[length:var(--t-sm)] uppercase tracking-[0.08em] text-[color:var(--bone-300)]">
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
                      <tr key={capability.id} className="border-b border-[var(--hide-700)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]">
                        <td className="px-4 py-3">
                          <p className="text-[length:var(--t-sm)] font-semibold">{capability.capabilityId} - {capability.name}</p>
                          <p className="t-muted">{capability.group} • {capability.status}</p>
                        </td>
                        {ROLE_OPTIONS.map((role) => {
                          const assigned = capability.assignedRoles.includes(role);
                          const needsReview = assigned && capability.status === 'DRAFT';
                          let assignmentClass = 'border-[var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)]';
                          let marker = '—';
                          if (needsReview) {
                            assignmentClass = 'border-[color:var(--restricted)] bg-[rgba(192,90,30,.22)] text-[color:var(--restricted-ink)]';
                            marker = '⚠';
                          } else if (assigned) {
                            assignmentClass = 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]';
                            marker = '✓';
                          }
                          return (
                            <td key={role} className="px-3 py-3">
                              <button
                                type="button"
                                onClick={() => toggleCapabilityRole(capability.id, role)}
                                className={`h-11 min-w-[90px] border px-2 text-[length:var(--t-xs)] font-bold ${assignmentClass}`}
                              >
                                {marker}
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
              <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
                <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Capability Builder</h2>
                <p className="t-body mt-[var(--s3)]">
                  Create and manage capability definitions without leaving the Admin Console.
                </p>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-name">Capability Name</label>
                    <input
                      id="builder-name"
                      value={builderName}
                      onChange={(event) => setBuilderName(event.target.value)}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-capability-id">Capability ID</label>
                    <input
                      id="builder-capability-id"
                      value={builderCapabilityId}
                      onChange={(event) => setBuilderCapabilityId(event.target.value)}
                      placeholder="CAP-###"
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-category">Category</label>
                    <input
                      id="builder-category"
                      value={builderCategory}
                      onChange={(event) => setBuilderCategory(event.target.value)}
                      className="input"
                    />
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-owner">Owner / Steward</label>
                    <input
                      id="builder-owner"
                      value={builderOwner}
                      onChange={(event) => setBuilderOwner(event.target.value)}
                      className="input"
                    />
                  </div>

                  <div className="lg:col-span-2">
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-description">Description</label>
                    <textarea
                      id="builder-description"
                      value={builderDescription}
                      onChange={(event) => setBuilderDescription(event.target.value)}
                      className="min-h-[110px] w-full border border-[color:var(--hide-700)] bg-[var(--hide-950)] px-3 py-2 text-[length:var(--t-sm)] text-[color:var(--bone-100)]"
                    />
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-primary-role">Primary Role</label>
                    <select
                      id="builder-primary-role"
                      value={builderPrimaryRole}
                      onChange={(event) => setBuilderPrimaryRole(event.target.value as RoleName)}
                      className="input"
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-status">Status</label>
                    <select
                      id="builder-status"
                      value={builderStatus}
                      onChange={(event) => setBuilderStatus(event.target.value as CapabilityStatus)}
                      className="input"
                    >
                      <option value="DRAFT">Draft</option>
                      <option value="ACTIVE">Active</option>
                      <option value="BLOCKED">Blocked</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-visibility">Visibility</label>
                    <select
                      id="builder-visibility"
                      value={builderVisibility}
                      onChange={(event) => setBuilderVisibility(event.target.value as CapabilityVisibility)}
                      className="input"
                    >
                      <option value="Internal">Internal</option>
                      <option value="Role-Bound">Role-Bound</option>
                      <option value="Public Placeholder">Public Placeholder</option>
                    </select>
                  </div>

                  <div>
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-dependencies">Dependencies</label>
                    <input
                      id="builder-dependencies"
                      value={builderDependencies}
                      onChange={(event) => setBuilderDependencies(event.target.value)}
                      className="input"
                    />
                  </div>

                  <div className="lg:col-span-2">
                    <p className="t-label mb-[var(--s3)] block">Secondary Roles</p>
                    <div className="flex flex-wrap gap-2">
                      {ROLE_OPTIONS.filter((role) => role !== builderPrimaryRole).map((role) => {
                        const selected = builderSecondaryRoles.includes(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            onClick={() => toggleSecondaryRole(role)}
                            className={`h-11 border px-3 text-[length:var(--t-xs)] font-bold ${
                              selected
                                ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                                : 'border-[color:var(--hide-700)] bg-[var(--hide-900)] text-[color:var(--bone-300)]'
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
                    <label className="t-label mb-[var(--s3)] block" htmlFor="builder-notes">Notes</label>
                    <textarea
                      id="builder-notes"
                      value={builderNotes}
                      onChange={(event) => setBuilderNotes(event.target.value)}
                      className="min-h-[90px] w-full border border-[color:var(--hide-700)] bg-[var(--hide-950)] px-3 py-2 text-[length:var(--t-sm)] text-[color:var(--bone-100)]"
                    />
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={saveCapability}
                    className="btn"
                  >
                    SAVE CAPABILITY
                  </button>
                  <button
                    type="button"
                    onClick={resetBuilder}
                    className="btn btn--ghost"
                  >
                    RESET FORM
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetBuilder();
                      setActiveTab('library');
                    }}
                    className="btn btn--ghost"
                  >
                    CANCEL
                  </button>
                </div>
              </article>
            </section>
          )}

          {activeTab === 'revenue' && <RevenueFundingCenter />}

          <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
            <button
              type="button"
              onClick={() => setShowTelemetry((current) => !current)}
              className="btn btn--ghost"
            >
              {showTelemetry ? 'Hide' : 'Show'} local event traces
            </button>

            {showTelemetry && (
              <div className="mt-3 max-h-[220px] overflow-y-auto border border-[var(--hide-700)] bg-[var(--hide-900)]">
                {eventTraces.length === 0 && <p className="px-4 py-3 text-[length:var(--t-sm)] text-[var(--bone-400)]">No traces yet.</p>}
                {eventTraces.map((trace, index) => (
                  <div key={`${trace.timestamp}-${index}`} className="border-b border-[var(--hide-700)] px-4 py-3 text-[length:var(--t-sm)] text-[var(--bone-400)]">
                    <span className="font-mono text-[color:var(--brass-300)]">[{trace.timestamp}]</span> {trace.action} - {trace.detail}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowIntegrationStubs((current) => !current)}
                className="btn btn--ghost"
              >
                {showIntegrationStubs ? 'Hide' : 'Show'} backend integration stubs
              </button>

              {showIntegrationStubs && (
                <div className="mt-3 border border-[var(--hide-700)] bg-[var(--hide-900)]">
                  {INTEGRATION_STUBS.map((item) => (
                    <div key={item} className="border-b border-[var(--hide-700)] px-4 py-3 text-[length:var(--t-sm)] text-[var(--bone-400)] last:border-b-0">
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
