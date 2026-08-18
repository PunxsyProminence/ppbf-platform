'use client';

import Link from 'next/link';
import React, { useState, useEffect } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import AthleteAchievements from './AthleteAchievements';
import Chalkboard from './Chalkboard';
import FightCard from './FightCard';
import GymWallModule from './GymWallModule';
import ParentDigest from './ParentDigest';
import ProfilePortrait from './ProfilePortrait';
import { ParentSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import type { FightCardPayload } from './profileClient';
import { cx } from './uiStyles';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

type TabID = 'overview' | 'parent-floor' | 'home-assignments' | 'observations' | 'family-goals' | 'messages' | 'attendance' | 'progress' | 'resources' | 'shadow';

interface Child {
  id: string;
  name: string;
  track: string;
  attendancePercent: number | null;
  currentProgress: string | null;

  /* Identity. A guardian is inside their own child's circle, so a released
     portrait reaches them -- and only their own children's, because the server
     resolves the guardian link per athlete before it decides anything (see
     profileVisibility.ts). Another family's child is not in this list at all,
     and would render a plate even if they were. */
  accountId: string | null;
  initials: string;
  photoAvailable: boolean;
}

interface HomeAssignment {
  id: string;
  title: string;
  dueDate: string;
  status: 'Pending' | 'In Progress' | 'Completed';
  description: string;
}

interface ParentObservation {
  id: string;
  category: string;
  value: number;
  notes: string;
}

interface FamilyGoal {
  id: string;
  title: string;
  supportAction: string;
  progress: number;
  targetDate: string;
}

interface ParentMessage {
  note_id: string;
  athlete_id: string;
  athlete_name: string | null;
  sender_role: string;
  note_text: string;
  created_at: string;
}

interface AttendanceEntry {
  id: string;
  childId: string;
  date: string;
  session: string;
  status: 'Present' | 'Excused' | 'Absent';
}

interface UpcomingSession {
  id: string;
  date: string;
  time: string;
  title: string;
  focus: string;
}

interface ProgressMilestone {
  id: string;
  childId: string;
  category: string;
  title: string;
  percent: number;
  status: 'On Track' | 'Needs Work' | 'Achieved';
}

interface ParentResource {
  id: string;
  title: string;
  type: 'Guide' | 'Checklist' | 'Video' | 'Policy';
  summary: string;
  actionLabel: string;
}

interface SafetySummary {
  activeHolds: number;
  flaggedGates: number;
}

/* This hub sits on the warm canvas ground (Law 6 — family-facing), so every
   tone below is mixed against paper, and every state pairs its colour with a
   glyph and an uppercase label via the .badge component (Law 3). */

function assignmentCardTone(status: HomeAssignment['status']): string {
  if (status === 'Completed') return 'bg-[color-mix(in_srgb,var(--cleared)_10%,var(--paper))] border-[color:var(--cleared)]';
  if (status === 'In Progress') return 'bg-[color-mix(in_srgb,var(--monitor)_10%,var(--paper))] border-[color:var(--monitor)]';
  return 'bg-[var(--paper)] border-[color:rgba(0,0,0,.18)]';
}

function assignmentBadge(status: HomeAssignment['status']): { className: string; glyph: string } {
  if (status === 'Completed') return { className: 'badge badge--cleared', glyph: '✓' };
  if (status === 'In Progress') return { className: 'badge badge--monitor', glyph: '◉' };
  return { className: 'badge badge--restricted', glyph: '▲' };
}

/* Selected tab / selected child: a control in the "on" position is brass
   chassis, never a status colour (Laws 1 and 2). */
const TAB_BASE =
  'inline-flex min-h-[44px] items-center rounded-[var(--r-sm)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.1em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const TAB_ACTIVE = 'border-[color:var(--brass-700)] bg-[var(--brass-500)] text-[color:var(--hide-950)]';
const TAB_INACTIVE =
  'border-[color:rgba(0,0,0,.18)] bg-[var(--paper-2)] text-[color:var(--hide-800)] hover:border-[color:var(--brass-700)]';

/* Progress on canvas: a brass fill on a recessed paper track — chrome, not a
   status claim. The percent is always printed next to it. */
const TRACK_CLASS = 'h-[8px] w-full rounded-[var(--r-pill)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)]';
const FILL_CLASS = 'h-full rounded-[var(--r-pill)] bg-[var(--brass-600)]';

export default function ParentHub() {
  const [activeTab, setActiveTab] = useState<TabID>('overview');

  // Real API: Children (athletes accessible to parent)
  const [children, setChildren] = useState<Child[]>([]);
  // The active child's fight card, fetched per selection. Fetched rather than
  // assembled here because the server decides what a guardian may see -- the
  // ring name and the coach's face on it have both been through the visibility
  // gate before they arrive.
  //
  // Stored WITH the id of the child it was fetched for, and matched against
  // the current selection at render -- the same shape RabbitHole.tsx uses to
  // keep one anchor's lessons off another anchor's card. This card carries a
  // named child's face, their handwritten ring name and the coach who is with
  // them; rendering it under a sibling's name is the wrong child's identity,
  // not a stale field. Absence is honest here -- a guardian whose card read
  // has not answered yet, or failed, simply has no card on the page -- so the
  // previous child's card comes down the moment the selection changes instead
  // of hanging there until the new one arrives.
  const [childCard, setChildCard] = useState<{ athleteId: string; card: FightCardPayload | null }>({
    athleteId: '',
    card: null,
  });
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const [childrenRetryNonce, setChildrenRetryNonce] = useState(0);

  const [activeChildId, setActiveChildId] = useState<string | null>(null);

  const [homeAssignments] = useState<HomeAssignment[]>([]);

  const [parentObservations] = useState<ParentObservation[]>([]);

  const [familyGoals] = useState<FamilyGoal[]>([]);

  // Capability #90, scoped to one-directional read: /api/pilot/parent/messages
  // reads pilot.coach_observations rows a coach/admin filed with
  // note_type: 'parent_message' (see coach/decision-loop's Message Home
  // panel). Best-effort, own effect, own state -- same doctrine as the
  // Safety & Consent card above: a failed read leaves the rest of the hub
  // working, it just shows no messages.
  const [messages, setMessages] = useState<ParentMessage[]>([]);
  // Whether the messages read actually answered. The tab's own empty state is
  // fine either way, but the SUMMARY TILE must not render a failed read as
  // "0 messages" -- that zero reads as "the gym has said nothing", which
  // nobody verified.
  const [messagesLoaded, setMessagesLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/messages`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: ParentMessage[] };
        setMessages(payload.items ?? []);
        setMessagesLoaded(true);
      } catch {
        // Messages tab falls back to its empty state; the summary tile shows
        // Unavailable because messagesLoaded stays false.
      }
    })();
  }, []);

  const [attendanceEntries] = useState<AttendanceEntry[]>([]);

  const [upcomingSessions] = useState<UpcomingSession[]>([]);

  const [progressMilestones] = useState<ProgressMilestone[]>([]);

  const [parentResources] = useState<ParentResource[]>([]);

  const [newMessage, setNewMessage] = useState('');

  // Capabilities #93/#167: this hub links to /parent/safety and
  // /parent/consent (both already built, #84/T-008) but never surfaced
  // either, so a guardian had no reason to know they existed. Best-effort,
  // own effect, own state -- a failure here must never block the rest of
  // this page, same doctrine as every other secondary read on this hub.
  const [safetySummary, setSafetySummary] = useState<SafetySummary | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/safety`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          items?: Array<{ hold: unknown; gates?: Array<{ outcome: string }> }>;
        };
        const items = payload.items ?? [];
        const activeHolds = items.filter((item) => item.hold).length;
        const flaggedGates = items.reduce(
          (total, item) => total + (item.gates ?? []).filter((gate) => gate.outcome === 'flagged' || gate.outcome === 'blocked').length,
          0,
        );
        setSafetySummary({ activeHolds, flaggedGates });
      } catch {
        // Card falls back to plain links with no summary line.
      }
    })();
  }, []);

  // Capabilities #95/#96: a real write path for a guardian-reported barrier
  // (no ride, an unsafe walk, something at home getting in the way), where
  // none existed before. Rides on pilot.coach_observations via a new
  // parent-only route -- see api/pilot/parent/barrier-report/route.ts for
  // why this is its own route rather than widening intake/domain-upsert.
  const [barrierType, setBarrierType] = useState<'home' | 'transportation'>('home');
  const [barrierDescription, setBarrierDescription] = useState('');
  const [barrierMessage, setBarrierMessage] = useState('');
  const [barrierSubmitting, setBarrierSubmitting] = useState(false);

  async function handleReportBarrier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChildId || !barrierDescription.trim() || barrierSubmitting) return;
    setBarrierMessage('');
    setBarrierSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/barrier-report`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: activeChildId,
          barrierType,
          description: barrierDescription,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'Failed to send the report.');
      }
      setBarrierDescription('');
      setBarrierMessage('Sent to your child\'s coach.');
    } catch (error) {
      setBarrierMessage(error instanceof Error ? error.message : 'Failed to send the report.');
    } finally {
      setBarrierSubmitting(false);
    }
  }

  // Fetch parent's children (athletes) from API
  //
  // The Retry button below bumps childrenRetryNonce, so this effect can run
  // again while its previous run is still in flight -- two roster reads, and
  // whichever lands last decides both the child list and the default
  // selection. Same AbortController guard as the per-child card read further
  // down: the superseded run is cancelled, and the aborted re-checks stop a
  // response that was already in the pipe from writing the list, the
  // selection, the error, or the spinner. The spinner is the one that would
  // bite hardest -- an aborted run's finally clearing childrenLoading would
  // put the empty "No children found" state on screen while the live read is
  // still working.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setChildrenLoading(true);
        setChildrenError(null);
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error('Failed to load children');

        const data = (await response.json()) as { items?: Array<{ athlete_id: string; full_name?: string }> };
        const items = data.items || [];
        
        // Do not fabricate attendance/progression values from index-based placeholders.
        const childList: Child[] = items.map((item) => {
          return {
            id: item.athlete_id,
            name: item.full_name || 'Unknown',
            track: 'Unavailable',
            attendancePercent: null,
            currentProgress: null,
            accountId: null,
            initials: '\u2014',
            photoAvailable: false,
          };
        });

        // One card per child, from the route that runs the visibility gate.
        // A guardian has one or two children, so this is one or two requests --
        // and going through /profile/card rather than a roster read is the
        // point: the roster route is staff-only, and a guardian must reach a
        // child's identity through the guardian link and nothing else.
        //
        // Best-effort: a failure leaves the child on the brass plate, which is
        // a finished object rather than a broken row.
        await Promise.all(childList.map(async (child) => {
          try {
            const cardResponse = await fetch(
              `${apiBase()}/api/pilot/profile/card?athlete_id=${encodeURIComponent(child.id)}`,
              { method: 'GET', credentials: 'include', signal: controller.signal },
            );
            if (!cardResponse.ok) return;
            const payload = (await cardResponse.json()) as { card?: FightCardPayload };
            if (!payload.card) return;
            child.accountId = payload.card.accountId;
            child.initials = payload.card.initials;
            child.photoAvailable = payload.card.photoAvailable;
          } catch {
            // Plate. An abort lands here too, and the plate is the correct
            // rendering for a portrait nobody managed to read.
          }
        }));
        if (controller.signal.aborted) return;

        setChildren(childList);
        // Functional update so the default selection does not read activeChildId
        // here: depending on it would refetch the whole roster and re-show the
        // loading spinner every time the parent switches child.
        setActiveChildId((current) => current || childList[0]?.id || current);
      } catch (error) {
        // A cancelled roster read is not a failed one -- it says nothing about
        // whether this guardian has children, so it must not empty the list or
        // put an error banner over a read that is still running.
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setChildrenError(error instanceof Error ? error.message : 'Failed to load children');
        setChildren([]);
      } finally {
        if (!controller.signal.aborted) setChildrenLoading(false);
      }
    })();
    return () => controller.abort();
  }, [childrenRetryNonce]);

  /* The active child's card, refetched on every switch. Refetched rather than
     cached from the list read so a ring name a coach cleared thirty seconds ago
     is gone the next time the guardian looks at it -- a takedown that survives
     only until the next full page load is not a takedown.

     REQUEST ORDERING. A guardian with two children switches between them with
     one tap, and the two card reads then race: the earlier request is not
     cancelled, so on a slow connection the FIRST child's card can arrive after
     the second child's and overwrite it, leaving one child's face, ring name
     and coach printed under their sibling's name. The AbortController closes
     it from both ends -- effect cleanup aborts the superseded request so it
     never lands, and the signal.aborted re-checks below mean a response that
     was already in the pipe when we aborted still cannot write state.

     Cleanup also covers unmount, which this effect previously had nothing for.
     This is the same guard, in the same shape, as the coach surface these
     records are shared with (app/coach/progression-intelligence) and the
     guardian's own progression page (app/parent/progression-visibility). */
  useEffect(() => {
    if (!activeChildId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChildCard({ athleteId: '', card: null });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/profile/card?athlete_id=${encodeURIComponent(activeChildId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setChildCard({ athleteId: activeChildId, card: null });
          return;
        }
        const payload = (await response.json()) as { card?: FightCardPayload };
        if (controller.signal.aborted) return;
        setChildCard({ athleteId: activeChildId, card: payload.card ?? null });
      } catch (error) {
        // A cancelled read is not a failure and must not write anything: the
        // guardian has already moved to another child, and "no card" for THIS
        // child was never observed. A genuine failure still falls through to
        // the plate, which is what a card that cannot be read looks like.
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setChildCard({ athleteId: activeChildId, card: null });
      }
    })();
    return () => controller.abort();
  }, [activeChildId]);

  const activeChild = children.find(c => c.id === activeChildId);
  // Only the card that was read for the child now selected. See the note on
  // the childCard state for why the match happens here.
  const shownCard = childCard.athleteId === activeChildId ? childCard.card : null;
  const hasLiveChildMetrics = activeChild?.attendancePercent !== null && Boolean(activeChild?.currentProgress);
  const activeAttendanceEntries = attendanceEntries.filter((entry) => entry.childId === activeChildId);
  const activeProgressMilestones = progressMilestones.filter((item) => item.childId === activeChildId);

  function milestoneStatusTone(status: ProgressMilestone['status']): string {
    if (status === 'Achieved') return 'border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_10%,var(--paper))]';
    if (status === 'Needs Work') return 'border-[color:var(--restricted)] bg-[color-mix(in_srgb,var(--restricted)_10%,var(--paper))]';
    return 'border-[color:rgba(0,0,0,.18)] bg-[var(--paper)]';
  }

  function milestoneBadge(status: ProgressMilestone['status']): { className: string; glyph: string } {
    if (status === 'Achieved') return { className: 'badge badge--cleared', glyph: '✓' };
    if (status === 'Needs Work') return { className: 'badge badge--restricted', glyph: '▲' };
    return { className: 'badge badge--monitor', glyph: '◉' };
  }

  /* Attendance outcomes on canvas take the -deep rungs (the text weights the
     sheet ships for the warm ground) and always carry their glyph. */
  function attendanceStatusTone(status: AttendanceEntry['status']): string {
    if (status === 'Present') return 'text-[color:var(--cleared-deep)]';
    if (status === 'Excused') return 'text-[color:var(--restricted-deep)]';
    return 'text-[color:var(--locked-deep)]';
  }

  function attendanceGlyph(status: AttendanceEntry['status']): string {
    if (status === 'Present') return '✓';
    if (status === 'Excused') return '▲';
    return '✕';
  }

  return (
    /* Family-facing surface — the warm canvas ground itself (Law 6), stated on
       the full-bleed wrapper so every component inside restates for cream. */
    <div className="on-canvas min-h-screen rounded-[var(--r-lg)] font-sans text-[color:var(--hide-900)]">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Parent Support Hub</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-2xl)' }}>Family Development Dashboard</h1>
            <p className="t-body mt-[var(--s3)]">Support your child&apos;s boxing journey with at-home assignments, family goals, and coach communication.</p>
          </div>
          {/* Both SHADOW buttons removed, and both destinations kept: the chat
              is offered by RoleStandaloneView above this component, and the
              Intel tab is in the tab row below. See the same note in
              CoachWorkspace.tsx.

              The motto strip went too. A gym's motto belongs on the gym's own
              voice -- the chalkboard, which is right below this -- not
              restated in --t-xs chrome at the top of every role's dashboard. */}
        </div>

        {/* This hub asks for its own surface. 'parent_hub' draws what an
            author addressed to guardians, and the read includes 'everywhere'
            by definition, so gym-wide items still arrive; items placed on the
            athlete or coach workspace still do not. */}
        <AnnouncementBanner
          placement="parent_hub"
          kind="notice"
          heading="Gym Notices"
          className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]"
        />

        {/* The chalkboard REPLACES the paper "From the Gym" card. Same rows,
            same placement ('parent_hub', which reads 'everywhere' too), same
            kind ('motivation'). What changed is that a line somebody wrote by
            hand now looks like one. See Chalkboard.tsx. */}
        <Chalkboard placement="parent_hub" />

        {/* The gym wall moved to the foot of this page for the same reason it
            moved on the athlete workspace: 421px of empty frames sat third from
            the top, above everything a parent came here to do. It is ambient
            furniture and correct as an object -- it is just not what a parent
            opens this page for. Rendered at the bottom now. */}

        <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
          <p className="t-label">Family Commitment</p>
          <p className="t-body mt-[var(--s2)]">Consistency at home builds confidence in the gym. Every ride, reminder, and check-in strengthens grit and motivation.</p>
        </div>

        {/* ROLE SUMMARY PANEL. Home tasks and upcoming sessions have NO
            backend feed yet (their arrays above are hardcoded empty), so
            those tiles pass null and render Unavailable -- a derived 0 from a
            feed that does not exist would tell a parent "nothing is due" and
            "nothing is scheduled", which nobody verified. The messages count
            is real only after its read answered. */}
        <ParentSummaryPanel
          childProgress={activeChild?.currentProgress || 'Unavailable - awaiting backend progression feed'}
          tasksDue={null}
          upcomingEvents={null}
          attendancePercent={activeChild?.attendancePercent ?? null}
          unreadMessages={messagesLoaded ? messages.length : null}
        />

        {!hasLiveChildMetrics && activeChild ? (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
            <p className="t-label">Data Availability</p>
            <p className="t-body mt-[var(--s2)]">Attendance and progression metrics are hidden until backend-authoritative feeds are available.</p>
          </div>
        ) : null}

        {/* CHILD SELECTOR */}
        {childrenLoading && (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] text-center">
            <p className="working">Loading your children...</p>
            <div className="mt-[var(--s4)] flex justify-center">
              <div className="animate-spin h-5 w-5 rounded-[var(--r-pill)] border-2 border-[color:var(--brass-700)] border-t-transparent"></div>
            </div>
          </div>
        )}

        {childrenError && !childrenLoading && (
          <div className="alert alert--critical" role="alert">
            <div className="alert-body">
              <div className="mb-[var(--s3)] flex items-center justify-between gap-[var(--s4)]">
                <span className="badge badge--locked"><i>✕</i>Failed</span>
                <button
                  onClick={() => {
                    setChildrenError(null);
                    setChildrenRetryNonce((value) => value + 1);
                  }}
                  className="btn btn--ghost"
                  aria-label="Retry loading children"
                >
                  Retry
                </button>
              </div>
              <p className="alert-msg">Error loading children: {childrenError}</p>
            </div>
          </div>
        )}

        {!childrenLoading && children.length === 0 && !childrenError && (
          <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] text-center">
            <p className="t-muted">No children found</p>
          </div>
        )}

        {!childrenLoading && children.length > 0 && (
          <div className="mat-paper flex flex-wrap gap-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
            {children.map(child => (
              <button
                key={child.id}
                onClick={() => setActiveChildId(child.id)}
                className={cx(
                  TAB_BASE,
                  'gap-[var(--s3)] pl-[var(--s2)]',
                  activeChildId === child.id ? TAB_ACTIVE : TAB_INACTIVE,
                )}
              >
                <ProfilePortrait
                  accountId={child.accountId}
                  initials={child.initials}
                  name={child.name}
                  photoAvailable={child.photoAvailable}
                  size="sm"
                  decorative
                />
                {child.name}
              </button>
            ))}
          </div>
        )}

        {/* TAB NAVIGATION */}
        <div className="mat-paper rounded-[var(--r-md)]">
          <div className="flex flex-wrap gap-[var(--s2)] p-[var(--s3)]">
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'parent-floor', label: 'Parent Floor' },
              { id: 'home-assignments', label: 'Assignments' },
              { id: 'observations', label: 'Observations' },
              { id: 'family-goals', label: 'Family Goals' },
              { id: 'messages', label: 'Messages' },
              { id: 'attendance', label: 'Attendance' },
              { id: 'progress', label: 'Progress' },
              { id: 'resources', label: 'Resources' },
              { id: 'shadow', label: 'SHADOW Intel' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabID)}
                className={cx(
                  TAB_BASE,
                  activeTab === tab.id ? TAB_ACTIVE : TAB_INACTIVE,
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* TAB CONTENT */}
        <div className="space-y-6">
          {/* OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6 panel-settle">
              {/* The digest leads the overview: the roadmap's "blind spot" is
                  the guardian who never sees the room, and the first thing
                  they should meet is the coach's own words, not a button
                  grid. */}
              <ParentDigest athleteId={activeChildId || null} childName={activeChild?.name ?? null} />

              <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
                <h3 className="t-label">Quick Actions</h3>
                <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2 lg:grid-cols-4">
                  <ShadowChatButton
                    context="Parent Overview"
                    label="SHADOW Chat"
                  />
                  <Link href="/schedule" className="btn w-full">
                    Open Scheduler
                  </Link>
                  <button
                    type="button"
                    onClick={() => setActiveTab('home-assignments')}
                    className="btn w-full"
                  >
                    Open Assignments
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('attendance')}
                    className="btn btn--ghost w-full"
                  >
                    Check Attendance
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('messages')}
                    className="btn btn--ghost w-full"
                  >
                    View Coach Messages
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('shadow')}
                    className="btn btn--ghost w-full"
                  >
                    Open SHADOW Intel
                  </button>
                </div>
              </section>

              {/* Safety & Consent: pure aggregation of two guardian-facing
                  surfaces this hub previously never linked to (#93/#167).
                  Non-alarming by default -- the count line only appears once
                  there is something for a guardian to actually look at, and
                  it names a scope/outcome, never staff detail. */}
              <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
                <h3 className="t-label">Safety &amp; Consent</h3>
                {safetySummary && (safetySummary.activeHolds > 0 || safetySummary.flaggedGates > 0) ? (
                  <p className="t-body mt-[var(--s2)]">
                    {safetySummary.activeHolds > 0 ? `${safetySummary.activeHolds} active training hold(s)` : null}
                    {safetySummary.activeHolds > 0 && safetySummary.flaggedGates > 0 ? ' and ' : null}
                    {safetySummary.flaggedGates > 0 ? `${safetySummary.flaggedGates} gate(s) awaiting clearance` : null}
                    {' '}across your children. This is not a punishment -- see the Safety page for details.
                  </p>
                ) : (
                  <p className="t-body mt-[var(--s2)]">Check your child&apos;s active training-hold and safety-gate status, and manage photo/video consent.</p>
                )}
                <div className="mt-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2">
                  <Link href="/parent/safety" className="btn w-full">
                    View Safety Status
                  </Link>
                  <Link href="/parent/consent" className="btn btn--ghost w-full">
                    Manage Consent
                  </Link>
                </div>
              </section>

              {/* The child's own card, on the family ground. Same component and
                  same materials the athlete sees on their own surface -- a
                  guardian looking at their kid's card is looking at the kid's
                  card, not at a parent-flavoured summary of it.

                  It carries the coach's name and face, which is the answer to
                  the question a guardian actually has: who is with my child.
                  Both the portrait and the ring name on it have already been
                  through the visibility gate server-side. */}
              {shownCard && <FightCard card={shownCard} />}

              {/* The paper version. Scoped to the child currently selected, and
                  the print route re-checks the guardian link server-side before
                  it renders anything -- a link is not an authorisation. */}
              {activeChildId && (
                <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-label">For the fridge</p>
                  <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                    <Link
                      href={`/print?athlete_id=${encodeURIComponent(activeChildId)}`}
                      className="btn btn--ghost"
                    >
                      Print their card and certificate
                    </Link>
                    <Link href="/names" className="btn btn--ghost">
                      The Wall of Names
                    </Link>
                  </div>
                </div>
              )}

              <HelpPanel
                title="Child Overview"
                description="Quick snapshot of your child's current training status, progress, and upcoming events."
                usage={[
                  'Review current track and skill level',
                  'Check attendance and progress summary',
                  'See upcoming events and important dates',
                  'Review coach messages'
                ]}
                mistakes={[
                  'Not staying informed about upcoming events',
                  'Missing coach communication',
                  'Overlooking skill milestones'
                ]}
              />

              {activeChild && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s5)]">
                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                    <h3 className="t-label">Current Status</h3>
                    <div className="space-y-[var(--s4)]">
                      <div>
                        <p className="t-label mb-[var(--s2)]">Child Name</p>
                        <p className="t-body font-semibold">{activeChild.name}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Current Track</p>
                        <p className="t-body font-semibold">{activeChild.track}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Progress</p>
                        <p className="t-body font-semibold">{activeChild.currentProgress || 'Unavailable - awaiting backend progression feed'}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Attendance</p>
                        {activeChild.attendancePercent !== null ? (
                          <p className="t-data" style={{ fontSize: 'var(--t-sm)' }}>{activeChild.attendancePercent}%</p>
                        ) : (
                          <p className="t-body font-semibold">Unavailable - not yet tracked</p>
                        )}
                      </div>
                      {/* Membership/scholarship/community-service status has no
                          backing column anywhere in the schema -- these used to
                          be hardcoded to the same "supported" values for every
                          family regardless of their actual status, which is a
                          real billing-adjacent misstatement, not a placeholder.
                          Show unavailable honestly until a real field exists. */}
                      <div>
                        <p className="t-label mb-[var(--s2)]">Membership Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Scholarship Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Community Service Support Status</p>
                        <p className="t-muted">Unavailable - not yet tracked</p>
                      </div>
                    </div>
                  </div>

                  <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                    <h3 className="t-label">How to Support</h3>
                    <ul className="space-y-[var(--s3)] t-body">
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Attend training sessions consistently</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Support home assignments and drills</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Maintain nutrition and sleep</span>
                      </li>
                      <li className="flex items-start gap-[var(--s3)]">
                        <span aria-hidden="true">✓</span>
                        <span>Stay informed through coach messages</span>
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PARENT FLOOR */}
          {activeTab === 'parent-floor' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Parent Floor"
                description="Your at-home support tasks. Track drills, assignments, and parent verification items."
                usage={[
                  'Review this week\'s parent support tasks',
                  'Help with assigned home drills',
                  'Track completion status',
                  'Report progress back to coaches'
                ]}
                mistakes={[
                  'Forgetting to review home assignments',
                  'Not providing dedicated practice time',
                  'Missing reporting deadlines'
                ]}
              />

              {/* #95/#96: the one real, working thing on this tab today. */}
              <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                <h3 className="t-label">Report a Barrier</h3>
                <p className="t-body">
                  Let your child&apos;s coach know if something at home, or getting here, is getting in the way of training.
                </p>

                {barrierMessage && (
                  <p className="t-body text-[color:var(--brass-300)]">{barrierMessage}</p>
                )}

                <form onSubmit={handleReportBarrier} className="space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Type</span>
                    <select
                      value={barrierType}
                      onChange={(event) => setBarrierType(event.target.value as 'home' | 'transportation')}
                      className="select"
                    >
                      <option value="home">Home</option>
                      <option value="transportation">Transportation</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">What&apos;s going on</span>
                    <textarea
                      value={barrierDescription}
                      onChange={(event) => setBarrierDescription(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn w-full" disabled={!activeChildId || barrierSubmitting}>
                    {barrierSubmitting ? 'Sending…' : 'Send to Coach'}
                  </button>
                </form>
              </div>

              <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
                <h3 className="t-label">This Week&apos;s Parent Support Tasks</h3>
                {/* Not-built-yet is a statement of fact, not a refusal or a
                    safety state, so it wears the label voice — never the
                    safety gate's red (Law 2). */}
                <p className="t-label max-w-[520px]">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="t-body">
                  There is no parent-task assignment feed wired to the backend yet. The checklist and progress
                  bar previously shown here were hardcoded example data, not real tasks -- they have been
                  removed rather than left showing fake completion status. Home assignments from your child&apos;s
                  coach appear in the Assignments tab once that feed is connected.
                </p>
              </div>
            </div>
          )}

          {/* HOME ASSIGNMENTS */}
          {activeTab === 'home-assignments' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Home Assignments"
                description="Coach-assigned work for home practice. Videos, drills, reflections, and skill development."
                usage={[
                  'Review assignment details and due dates',
                  'Support your child with execution',
                  'Upload evidence if requested',
                  'Mark completion status'
                ]}
                mistakes={[
                  'Missing assignment deadlines',
                  'Not understanding assignment goals',
                  'Skipping optional evidence uploads'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for home assignments yet, so this
                list is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {homeAssignments.map(assignment => {
                  const badge = assignmentBadge(assignment.status);
                  return (
                    <div key={assignment.id} className={`border-2 p-[var(--s4)] rounded-[var(--r-md)] ${assignmentCardTone(assignment.status)}`}>
                      <div className="flex justify-between items-start gap-[var(--s3)] mb-[var(--s3)]">
                        <h4 className="t-body font-semibold">{assignment.title}</h4>
                        <span className={badge.className}><i>{badge.glyph}</i>{assignment.status}</span>
                      </div>
                      <p className="t-body mb-[var(--s3)]">{assignment.description}</p>
                      <p className="t-muted">Due: {assignment.dueDate}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* OBSERVATIONS */}
          {activeTab === 'observations' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Parent Observations"
                description="Record what you notice at home about your child's energy, motivation, stress, and development."
                usage={[
                  'Note energy and motivation levels',
                  'Track sleep and recovery',
                  'Observe behavior changes',
                  'Report concerns to coaches'
                ]}
                mistakes={[
                  'Not reporting concerning changes',
                  'Minimizing stress or pain mentions',
                  'Not sharing positive observations'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed or entry form for parent observations
                yet, so this section is always empty.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--s4)]">
                {parentObservations.map(obs => (
                  <div key={obs.id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s3)]">
                    <h4 className="t-body font-semibold">{obs.category}</h4>
                    <div>
                      <div className="flex justify-between mb-[var(--s2)]">
                        <span className="t-label">Rating</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{obs.value}/10</span>
                      </div>
                      <div className={TRACK_CLASS}>
                        <div className={FILL_CLASS} style={{width: `${obs.value * 10}%`}}></div>
                      </div>
                    </div>
                    {obs.notes && (
                      <p className="t-muted italic mt-[var(--s3)]">{obs.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* FAMILY GOALS */}
          {activeTab === 'family-goals' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Family Goals"
                description="Collaborative family goals that support your child's boxing journey."
                usage={[
                  'Review family support goals',
                  'Track progress toward goals',
                  'Work together as a family',
                  'Celebrate achievements'
                ]}
                mistakes={[
                  'Setting unrealistic goals',
                  'Not reviewing progress regularly',
                  'Not involving the whole family'
                ]}
              />

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for family goals yet, so this section
                is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {familyGoals.map(goal => (
                  <div key={goal.id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)] space-y-[var(--s4)]">
                    <div className="flex justify-between items-start gap-[var(--s3)]">
                      <h4 className="t-body font-semibold">{goal.title}</h4>
                      <span className="t-muted">{goal.targetDate}</span>
                    </div>
                    <p className="t-body">{goal.supportAction}</p>
                    <div>
                      <div className="flex justify-between mb-[var(--s2)]">
                        <span className="t-label">Progress</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{goal.progress}%</span>
                      </div>
                      <div className={TRACK_CLASS}>
                        <div className={FILL_CLASS} style={{width: `${goal.progress}%`}}></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MESSAGES */}
          {activeTab === 'messages' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Coach Messages"
                description="Receive updates and messages from coaches about your child's progress."
                usage={[
                  'Check regularly for coach updates',
                  'Respond to coach requests promptly',
                  'Ask questions about training',
                  'Share relevant home observations'
                ]}
                mistakes={[
                  'Ignoring coach messages',
                  'Delayed responses to urgent matters',
                  'Not sharing important information'
                ]}
              />

              {messages.length === 0 ? (
                <p className="t-muted">No messages yet.</p>
              ) : (
                <div className="space-y-[var(--s4)] max-h-96 overflow-y-auto">
                  {messages.map((message) => (
                    <div key={message.note_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                      <div className="flex justify-between items-start gap-[var(--s3)] mb-[var(--s3)]">
                        <h4 className="t-body font-semibold">{message.athlete_name ?? 'Your child'}</h4>
                        <span className="t-label">From {message.sender_role === 'coach' ? 'Coach' : 'Admin'}</span>
                      </div>
                      <p className="t-body mb-[var(--s3)]">{message.note_text}</p>
                      <p className="t-muted">{formatGymDateTimeShort(message.created_at) ?? message.created_at}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s4)]">
                <h4 className="t-label">Reply to Coach</h4>
                <p className="t-label">
                  PLANNED | NOT YET IMPLEMENTED
                </p>
                <p className="t-muted">
                  Messages from your child&apos;s coach appear above, but replying isn&apos;t available yet. This
                  field is disabled so a message can&apos;t be typed and silently discarded -- for anything that
                  needs a conversation, contact your child&apos;s coach directly.
                </p>
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Messaging is not yet available."
                  disabled
                  className="textarea h-20 resize-none cursor-not-allowed opacity-60"
                />
                <button
                  type="button"
                  disabled
                  className="btn cursor-not-allowed opacity-50 grayscale"
                >
                  Send Message (unavailable)
                </button>
              </div>
            </div>
          )}

          {/* ATTENDANCE */}
          {activeTab === 'attendance' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] panel-settle">
              <h3 className="t-label">Attendance Tracking</h3>
              <p className="t-body">View attendance history and upcoming sessions.</p>
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for attendance history or upcoming
                sessions yet, so these lists are always empty.
              </p>

              <div className="space-y-[var(--s3)]">
                {activeAttendanceEntries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                    <div>
                      <p className="t-body font-semibold">{entry.date} | {entry.session}</p>
                    </div>
                    <span className={`text-[length:var(--t-sm)] font-semibold uppercase ${attendanceStatusTone(entry.status)}`}>
                      <span aria-hidden="true">{attendanceGlyph(entry.status)}</span> {entry.status}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)] space-y-[var(--s3)]">
                <h4 className="t-body font-semibold">Upcoming Sessions</h4>
                {upcomingSessions.map((session) => (
                  <div key={session.id} className="t-body">
                    <p><strong>{session.date} {session.time}</strong> - {session.title}</p>
                    <p>Focus: {session.focus}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROGRESS */}
          {activeTab === 'progress' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] panel-settle">
              <h3 className="t-label">Progress & Achievements</h3>
              <p className="t-body">Track skill development and milestone achievements.</p>

              {/* THE SAME ACHIEVEMENTS, SAID TO SOMEBODY WHO WAS NOT IN THE ROOM.
                  Not a simplified subset and not a different set of facts: the
                  identical rows the athlete sees, rendered with each entry's
                  family wording. A parent does not parse RPE or "slip and
                  return", and translating that is not talking down -- it is
                  answering the question they actually have, which is whether
                  their kid is showing up, sticking with it, helping anyone, and
                  getting stronger.

                  READ-ONLY, and the ceremony is silent here: the bell belongs to
                  the person who earned the thing. */}
              {activeChildId && (
                <AthleteAchievements
                  athleteId={activeChildId}
                  athleteName={activeChild?.name}
                  audience="family"
                  allowProgramChange={false}
                />
              )}

              <details className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                <summary className="t-body cursor-pointer font-semibold">Parent-Support Visibility Placeholder</summary>
                <p className="t-label mt-[var(--s3)]">
                  CLOSED-LOOP PROGRESSION INTELLIGENCE - PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED
                </p>
                <Link href="/parent/progression-visibility" className="btn btn--ghost mt-[var(--s3)]">
                  Open Parent Progression Visibility
                </Link>
              </details>

              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for progress milestones yet, so this
                list is always empty.
              </p>

              <div className="space-y-[var(--s4)]">
                {activeProgressMilestones.map((milestone) => {
                  const badge = milestoneBadge(milestone.status);
                  return (
                    <div key={milestone.id} className={`rounded-[var(--r-md)] border-2 p-[var(--s4)] ${milestoneStatusTone(milestone.status)}`}>
                      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                        <p className="t-body font-semibold">{milestone.category}: {milestone.title}</p>
                        <span className={badge.className}><i>{badge.glyph}</i>{milestone.status}</span>
                      </div>
                      <div className="mt-[var(--s3)]">
                        <div className="flex justify-between mb-[var(--s2)]">
                          <span className="t-label">Progress</span>
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>{milestone.percent}%</span>
                        </div>
                        <div className={TRACK_CLASS}>
                          <div className={FILL_CLASS} style={{ width: `${milestone.percent}%` }}></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* RESOURCES */}
          {activeTab === 'resources' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] panel-settle">
              <h3 className="t-label">Parent Support Resources</h3>
              <p className="t-body">Guides, videos, and tips for supporting young athletes.</p>
              <p className="t-label">
                PLANNED | NOT YET IMPLEMENTED -- there is no backend feed for parent resources yet, so this
                list is always empty.
              </p>
              <div className="space-y-[var(--s3)]">
                {parentResources.map((resource) => (
                  <div key={resource.id} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                    <p className="t-body font-semibold">{resource.title}</p>
                    <p className="t-muted mt-[var(--s2)]">Type: {resource.type}</p>
                    <p className="t-body mt-[var(--s2)]">{resource.summary}</p>
                    <button className="btn mt-[var(--s3)]">
                      {resource.actionLabel}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SHADOW AI */}
          {activeTab === 'shadow' && (
            <div className="space-y-6 panel-settle">
              <RoleSpecificShadow
                role="parent"
                description="Ask SHADOW how to support your child at home. Tap below to open a live chat scoped to your family -- there is no canned answer here."
                chatContext="Parent Hub"
              />
            </div>
          )}
        </div>

        {/* The gym wall, at the foot of the page. See the note where it used to
            hang, above the family commitment card. */}
        <GymWallModule className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]" />
      </div>
    </div>
  );
}

