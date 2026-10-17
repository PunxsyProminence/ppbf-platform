'use client';

import Link from 'next/link';
import React, { useState, useEffect, useRef } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import AthleteAchievements from './AthleteAchievements';
import AthleteGoalsReadOnly from './AthleteGoalsReadOnly';
import ParentProgressSummary, { type SupportTasks } from './ParentProgressSummary';
import ParentAssignmentList from './ParentAssignmentList';
import ParentObservations from './ParentObservations';
import Chalkboard from './Chalkboard';
import FightCard from './FightCard';
import GymWallModule from './GymWallModule';
import ParentDigest from './ParentDigest';
import ProfilePortrait from './ProfilePortrait';
import { ParentSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import type { FightCardPayload } from './profileClient';
import { cx } from './uiStyles';
import ParentFamilyGoals from './ParentFamilyGoals';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymDateTimeShort, formatGymDay, gymDayIso } from '@/src/lib/gymTime';
import { earnedMilestoneKeys } from '@/src/shared/achievementPaths';

type TabID = 'overview' | 'parent-floor' | 'home-assignments' | 'observations' | 'family-goals' | 'messages' | 'attendance' | 'progress' | 'resources' | 'shadow';

interface Child {
  id: string;
  name: string;
  track: string;

  /* Identity. A guardian is inside their own child's circle, so a released
     portrait reaches them -- and only their own children's, because the server
     resolves the guardian link per athlete before it decides anything (see
     profileVisibility.ts). Another family's child is not in this list at all,
     and would render a plate even if they were. */
  accountId: string | null;
  initials: string;
  photoAvailable: boolean;
}

/* The task on a message: present when a coach gave the message a due date
   (pilot.parent_task_state), null when they did not. The route sends null
   rather than omitting the key, so "no task" and "not loaded" stay apart. */
interface ParentMessageTask {
  due_date: string | null;
  completed_at: string | null;
}

/* A guardian's own reply to a parent message (#1542, FC-03). Only this
   guardian's: GET /api/pilot/parent/message-replies never returns a
   co-guardian's. */
interface FamilyReply {
  reply_id: string;
  note_id: string;
  reply_text: string;
  created_at: string;
}

interface ParentMessage {
  note_id: string;
  athlete_id: string;
  athlete_name: string | null;
  sender_role: string;
  note_text: string;
  created_at: string;
  task: ParentMessageTask | null;
}

/* A due date is a bare calendar date ('2026-10-20', Postgres date::text).
   formatGymDay keeps a bare date on the calendar day it names (it does not
   shift it into the gym's zone, which would print the day before). Anything
   it cannot read is shown as typed. */
function formatDueDate(value: string): string {
  return formatGymDay(value) ?? value;
}

/** A task is open until the family ticks it. */
function isOpenTask(message: ParentMessage): boolean {
  return message.task !== null && message.task.completed_at === null;
}

/* THE GYM'S WEEK, Monday to Sunday on the gym's calendar (America/New_York,
   gymDayIso), as the two bare dates that bound it. A due date is a bare
   calendar date too ('2026-10-20'), so membership is a string comparison
   between like things. The arithmetic runs on UTC midnight of the gym's
   today, which has no daylight-saving edge to fall off. */
/** A due date the week can be judged by: the bare 'YYYY-MM-DD' the route
 *  sends. Anything else is shown as typed and judged by nobody. */
function isCalendarDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function gymWeekBounds(nowMs: number): { start: string; end: string } | null {
  const today = gymDayIso(nowMs);
  if (!today) return null;
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  const day = 24 * 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(midnight - sinceMonday * day), end: iso(midnight + (6 - sinceMonday) * day) };
}

interface AttendanceEntry {
  id: string;
  childId: string;
  date: string;
  session: string;
  status: 'Present' | 'Excused' | 'Absent';
}

/* `focus` is gone. The scheduler has no such field -- pilot.scheduler_classes
   carries title, start/end, location, capacity and status, and nothing that
   says what a session is working on. It was renderable only while this list
   was hardcoded. `location` and `standing` replace it because both are real
   columns a guardian can act on: where to drop their kid off, and whether the
   kid actually has a place or is on the waitlist. */
interface UpcomingSession {
  id: string;
  date: string;
  title: string;
  location: string;
  standing: 'Registered' | 'Waitlisted';
}

/* The three scheduler shapes this hub reads, narrowed to the fields it
   renders. Deliberately not the full SchedulerClass/Registration/Attendance
   interfaces from schedulerDb: a client type listing columns the client never
   shows invites the next person to show them. */
interface SchedulerFeedClass {
  class_id: string;
  title: string;
  start_at: string;
  location: string;
  status: 'open' | 'full' | 'cancelled';
}

interface SchedulerFeedRegistration {
  registration_id: string;
  class_id: string;
  athlete_id: string;
  status: 'registered' | 'waitlisted' | 'cancelled';
}

interface SchedulerFeedAttendance {
  attendance_id: string;
  class_id: string;
  athlete_id: string;
  status: 'present' | 'absent' | 'excused';
  checked_in_at: string;
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

/* Selected tab / selected child: a control in the "on" position is brass
   chassis, never a status colour (Laws 1 and 2). */
/* --t-sm, not --t-xs: a guardian reads these on a phone in the car park,
   and 11.8px uppercase mono was the smallest text on the page. Still a
   desk size (no kiosk attribute; OD-2026-10-08-011). */
const TAB_BASE =
  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border-2 px-[var(--s4)] font-mono text-[length:var(--t-sm)] font-bold uppercase tracking-[0.1em] transition focus-visible:outline-none focus-visible:shadow-[var(--focus)]';
const TAB_ACTIVE = 'border-[color:var(--brass-700)] bg-[var(--brass-500)] text-[color:var(--hide-950)]';
const TAB_INACTIVE =
  'border-[color:rgba(0,0,0,.18)] bg-[var(--paper-2)] text-[color:var(--hide-800)] hover:border-[color:var(--brass-700)]';

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

  // Capability #90, scoped to one-directional read: /api/pilot/parent/messages
  // reads pilot.coach_observations rows a coach/admin filed with
  // note_type: 'parent_message' (see coach/decision-loop's Message Home
  // panel). Best-effort, own effect, own state -- same doctrine as the
  // Safety & Consent card above: a failed read leaves the rest of the hub
  // working, it just shows no messages.
  const [messages, setMessages] = useState<ParentMessage[]>([]);
  // Whether the messages read actually answered. Neither surface that reads
  // it may render an unanswered read as an absence of messages: the SUMMARY
  // TILE must not show "0" and the MESSAGES TAB must not say "No messages
  // yet." Both of those tell a guardian the gym has said nothing to them,
  // which nobody verified. (The tab was exempted here until 2026-08-25 on the
  // grounds that its empty state was "fine either way"; it is the same claim
  // as the tile's zero, in words.)
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  // Kept apart from "not loaded yet" for the one reader that says the two
  // differently (the Progress tab's support-task line).
  const [messagesFailed, setMessagesFailed] = useState(false);
  // The clock reading the Parent Floor's week is judged against. Taken as the
  // messages land, then again each minute and whenever the page comes back
  // into view, so a hub left open past Sunday midnight moves to the new week
  // rather than going on calling last week "this week". Render must not read
  // the clock itself (react-hooks/purity).
  const [floorClockMs, setFloorClockMs] = useState(0);
  useEffect(() => {
    const tick = () => setFloorClockMs(Date.now());
    const interval = window.setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/messages`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) {
          setMessagesFailed(true);
          return;
        }
        const payload = (await response.json()) as { items?: Array<Omit<ParentMessage, 'task'> & { task?: ParentMessageTask | null }> };
        // The route sends task: null, never omits it; an item without the
        // key (an older answer, a stub) is read as "no task", not as a crash.
        setMessages((payload.items ?? []).map((item) => ({ ...item, task: item.task ?? null })));
        setFloorClockMs(Date.now());
        setMessagesLoaded(true);
      } catch {
        // Messages tab falls back to its empty state; the summary tile shows
        // Unavailable because messagesLoaded stays false.
        setMessagesFailed(true);
      }
    })();
  }, []);

  /* OPENING A MESSAGE (#1542, FC-05). A coach's message counts as opened when
     at least half of it is on screen on the Messages tab (FC-05 Q-1 default
     A) -- not when the inbox is fetched, which the hub does on load for its
     summary tile too. Each message is recorded once per visit (POST
     /api/pilot/parent/message-reads; the server keeps the first time). Only
     the message itself is watched, not the replies under it. A failed write
     is not the guardian's to deal with: it is not shown, and the message is
     tried again when the tab is next opened or the list reloads. */
  const readsSentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeTab !== 'messages' || !messagesLoaded || messages.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // Half of the message on screen -- or, for a message taller than the
        // screen, half of the screen filled with it, since such a message can
        // never be half on screen at once.
        const fillsHalfTheScreen = entry.rootBounds !== null
          && entry.intersectionRect.height >= 0.5 * entry.rootBounds.height;
        if (!entry.isIntersecting || (entry.intersectionRatio < 0.5 && !fillsHalfTheScreen)) continue;
        const noteId = (entry.target as HTMLElement).dataset.readNote;
        if (!noteId || readsSentRef.current.has(noteId)) continue;
        readsSentRef.current.add(noteId);
        observer.unobserve(entry.target);
        void fetch(`${apiBase()}/api/pilot/parent/message-reads`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note_id: noteId }),
        })
          .then((response) => {
            if (!response.ok) readsSentRef.current.delete(noteId);
          })
          .catch(() => {
            readsSentRef.current.delete(noteId);
          });
      }
    // Every 1%: a message many screens tall changes its visible share only a
    // little as it scrolls, so coarse steps could never fire again after the
    // first sliver, and it would never be seen filling half the screen.
    }, { threshold: Array.from({ length: 101 }, (_, step) => step / 100) });
    document.querySelectorAll<HTMLElement>('[data-read-note]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [activeTab, messagesLoaded, messages]);

  /* REPLYING TO A MESSAGE (#1542, FC-03). Each message has its own reply
     box; a reply is stored under that message and the gym's staff read it
     under the note they posted. This guardian's earlier replies are read once,
     on their own: a failed read says so above the list and the boxes still
     work. One send per press per message (a ref, as with the barrier report:
     two presses in one tick both read the same state). A failed send keeps the
     text and says why. Nothing here is emailed or pushed. */
  const [ownReplies, setOwnReplies] = useState<FamilyReply[]>([]);
  const [repliesFailed, setRepliesFailed] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyBusy, setReplyBusy] = useState<Set<string>>(() => new Set());
  const replySendingRef = useRef<Set<string>>(new Set());
  // One notice per message: a send on one message leaves another's failure
  // showing while its unsent text is still in the box.
  const [replyNotices, setReplyNotices] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/message-replies`, {
          method: 'GET',
          credentials: 'include',
        });
        const payload = (await response.json().catch(() => null)) as { items?: unknown } | null;
        if (!response.ok || !Array.isArray(payload?.items)) {
          setRepliesFailed(true);
          return;
        }
        setOwnReplies(payload.items as FamilyReply[]);
      } catch {
        setRepliesFailed(true);
      }
    })();
  }, []);

  async function handleSendReply(noteId: string) {
    const text = (replyDrafts[noteId] ?? '').trim();
    if (!text || replySendingRef.current.has(noteId)) return;
    replySendingRef.current.add(noteId);
    setReplyNotices((held) => ({ ...held, [noteId]: '' }));
    setReplyBusy((held) => new Set(held).add(noteId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/message-replies`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId, reply_text: text }),
      });
      const payload = (await response.json().catch(() => null)) as
        { ok?: boolean; error?: string; item?: FamilyReply } | null;
      if (!response.ok || payload?.ok !== true || !payload.item || typeof payload.item !== 'object') {
        throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : 'The reply did not save.');
      }
      const item = payload.item;
      setOwnReplies((held) => [...held, item]);
      // Cleared only if the box still holds what was sent: anything typed
      // while the send was in flight stays.
      setReplyDrafts((held) => ((held[noteId] ?? '').trim() === text ? { ...held, [noteId]: '' } : held));
    } catch (error) {
      const reason = (error instanceof Error && error.message ? error.message : 'the gym could not be reached').replace(/\.$/, '');
      setReplyNotices((held) => ({
        ...held,
        [noteId]: `That reply did not send -- ${reason}. Your text is still in the box; try again.`,
      }));
    } finally {
      replySendingRef.current.delete(noteId);
      setReplyBusy((held) => {
        const next = new Set(held);
        next.delete(noteId);
        return next;
      });
    }
  }

  /* TICKING A TASK OFF. POST /api/pilot/parent/messages {note_id, completed}
     is the one write a guardian makes on this tab; the route scopes the note
     to this guardian's own children on every call. Both directions are
     allowed (a wrong tick must be undoable). The row is updated from the
     ANSWER, not from the click: the box shows what the server holds, and a
     refused or dropped write leaves it where it was and says so in words. */
  const [taskBusy, setTaskBusy] = useState<Set<string>>(() => new Set());
  // A failed tick's notice carries the child the task is about, so the
  // Parent Floor shows it only under that child -- including when the write
  // fails after the guardian has switched to a sibling. The Messages tab
  // lists every child's messages and shows it whichever child is selected.
  const [taskNotice, setTaskNotice] = useState<{ athleteId: string; text: string } | null>(null);
  // Tasks ticked or unticked on this visit. A carry-forward task ticked off
  // stays on the Parent Floor, ticked, until the page is next loaded, so a
  // wrong tick can be undone where it was made instead of vanishing.
  const [tasksTouched, setTasksTouched] = useState<Set<string>>(() => new Set());

  async function handleTaskToggle(noteId: string, completed: boolean) {
    if (taskBusy.has(noteId)) return;
    setTaskNotice(null);
    const aboutAthlete = messages.find((message) => message.note_id === noteId)?.athlete_id ?? '';
    setTaskBusy((held) => new Set(held).add(noteId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId, completed }),
      });
      const payload = (await response.json().catch(() => null)) as
        { ok?: boolean; error?: string; task?: ParentMessageTask } | null;
      if (!response.ok || payload?.ok !== true || !payload.task || typeof payload.task !== 'object') {
        throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : 'The tick did not save.');
      }
      const task = payload.task;
      setTasksTouched((held) => new Set(held).add(noteId));
      setMessages((held) =>
        held.map((message) => (message.note_id === noteId ? { ...message, task } : message)),
      );
    } catch (error) {
      setTaskNotice({
        athleteId: aboutAthlete,
        text: `That tick did not save -- ${error instanceof Error ? error.message : 'the gym could not be reached'}. The box shows what the gym has on record; try again.`,
      });
    } finally {
      setTaskBusy((held) => {
        const next = new Set(held);
        next.delete(noteId);
        return next;
      });
    }
  }

  /* SLICE 8. The scheduler already answers this and the hub was not asking.
     GET /api/pilot/scheduler's parent branch filters registrations, coaching
     requests and attendance to the guardian's linked athletes server-side, so
     ONE read covers every child and the per-child split happens in render
     below.

     NOT classes, and that correction is deliberate rather than pedantic: this
     comment used to say "filters classes, registrations and attendance", and
     the classes half was never true. route.ts binds `const classes =
     store.classes` and returns it verbatim on every branch, because a family
     browses the whole catalogue to register against it. A comment that
     asserts a filter nobody wrote is worse than no comment -- the next reader
     leans on it. What the route DOES narrow on the class rows is their
     fields: no *_account_id reaches a parent or an athlete. 

     That is also why this effect has no activeChildId dependency: switching
     children re-filters data already in hand rather than firing a request
     that could land after the guardian has moved on. The stale-response
     hazard the child-card effect has to guard against does not arise here,
     because there is nothing in flight to arrive late.

     NO PERCENTAGE IS COMPUTED HERE, and that is a decision rather than an
     omission.

     Correcting what an earlier version of this comment claimed: pilot DOES
     define an attendance rate. attendanceReporting.ts computes
     present / (present + absent), rounded to three places, with excused marks
     excluded from both sides and null returned when there is no present or
     absent mark to divide -- never a fabricated 0%. That is a real metric with
     a real source authority, and saying otherwise here was wrong.

     What it is not is a rate a GUARDIAN can read without being misled. Its
     denominator is sessions somebody MARKED, not sessions this child was
     expected at, because pilot.scheduler_attendance records what happened and
     nothing records what was supposed to happen. A child marked present once
     and never marked again reads 100%. A coach who marks a register every week
     produces a lower number, for the same child, than a coach who marks it
     when something notable occurs -- so the figure moves with staff habit
     rather than with the kid. A guardian reading "68% attendance" has no way
     to see any of that.

     So the events below are shown and no rate is derived from them. If a
     parent-facing attendance figure is wanted, the decision to make first is
     which denominator it uses, and that is already flagged as its own
     scoping decision on the read route that owns this data --
     /api/pilot/scheduler/attendance-summary forbids parent outright and says
     why. This comment should not be read as "nobody has defined a rate"; it
     should be read as "the defined one answers a different question." */
  const [schedulerFeedState, setSchedulerFeedState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [schedulerFeed, setSchedulerFeed] = useState<{
    classes: SchedulerFeedClass[];
    registrations: SchedulerFeedRegistration[];
    attendance: SchedulerFeedAttendance[];
    /** The clock reading the feed is judged against, taken as it landed.
     *  Render must not read the clock itself (react-hooks/purity). */
    readAtMs: number;
  }>({ classes: [], registrations: [], attendance: [], readAtMs: 0 });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/scheduler`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setSchedulerFeedState('failed');
          return;
        }
        const payload = (await response.json()) as {
          classes?: SchedulerFeedClass[];
          registrations?: SchedulerFeedRegistration[];
          attendance?: SchedulerFeedAttendance[];
        };
        if (controller.signal.aborted) return;
        setSchedulerFeed({
          classes: payload.classes ?? [],
          registrations: payload.registrations ?? [],
          attendance: payload.attendance ?? [],
          readAtMs: Date.now(),
        });
        setSchedulerFeedState('loaded');
      } catch (error) {
        // A cancelled read is not a failure: nothing was observed, so nothing
        // should be claimed. Only a real fault becomes 'failed', which is what
        // makes "Unavailable" below mean unavailable and not merely empty.
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setSchedulerFeedState('failed');
      }
    })();
    return () => controller.abort();
  }, []);

  const [parentResources] = useState<ParentResource[]>([]);

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
  // One report per press (#1529): a ref, because two presses in one tick both
  // read the same `barrierSubmitting` and both got through.
  const barrierSubmittingRef = useRef(false);

  async function handleReportBarrier(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChildId || !barrierDescription.trim() || barrierSubmitting || barrierSubmittingRef.current) return;
    barrierSubmittingRef.current = true;
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
      barrierSubmittingRef.current = false;
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

  /* The selected child's latest weigh-in and seven-day change
     (/api/pilot/parent/body-mass; elite-boxing item 5). Keyed by athlete like
     childCard, so a slow answer for one child never shows under another's
     name. Null when there is nothing in the last month or the read failed;
     the card is simply absent then. */
  const [childBodyMass, setChildBodyMass] = useState<{
    athleteId: string;
    pounds: number;
    observedAt: string;
    flagText: string | null;
  } | null>(null);
  useEffect(() => {
    if (!activeChildId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/parent/body-mass?athlete_id=${encodeURIComponent(activeChildId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const payload = response.ok
          ? (await response.json().catch(() => ({}))) as {
            body_mass?: { latest?: { pounds?: unknown; observed_at?: unknown }; flag_text?: unknown } | null;
          }
          : {};
        if (controller.signal.aborted) return;
        const latest = payload.body_mass?.latest;
        setChildBodyMass(
          latest && typeof latest.pounds === 'number' && typeof latest.observed_at === 'string'
            ? {
              athleteId: activeChildId,
              pounds: latest.pounds,
              observedAt: latest.observed_at,
              flagText: typeof payload.body_mass?.flag_text === 'string' ? payload.body_mass.flag_text : null,
            }
            : null,
        );
      } catch {
        if (!controller.signal.aborted) setChildBodyMass(null);
      }
    })();
    return () => controller.abort();
  }, [activeChildId]);
  const shownBodyMass = childBodyMass?.athleteId === activeChildId ? childBodyMass : null;

  /* PROGRESS is what the child has earned, not a score (WO-PH-01 Q1 = A),
     from the awards and the logged-session count that
     /api/pilot/achievements/milestones already serves a guardian, after the
     route checks the guardian link to this child. The count is
     earnedMilestoneKeys, the function AthleteAchievements on the Progress tab
     counts with: the session-count milestones are earned from the count and
     have no award row, and an award whose key left the catalogue is not
     shown there, so a raw row count would disagree with the tab. Keyed by
     athlete like childBodyMass, and the superseded read is aborted, so a
     slow answer for one child never shows under the other's name. 'failed'
     is kept apart from a real zero: a child with nothing earned yet reads 0,
     a read that did not answer reads Unavailable. */
  const [childProgress, setChildProgress] = useState<
    | { athleteId: string; state: 'loaded'; milestonesEarned: number; sessionsCompleted: number }
    | { athleteId: string; state: 'failed' }
    | null
  >(null);
  useEffect(() => {
    if (!activeChildId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(activeChildId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const payload = response.ok
          ? (await response.json().catch(() => null)) as { items?: unknown; completed_sessions?: unknown } | null
          : null;
        if (controller.signal.aborted) return;
        if (!payload || !Array.isArray(payload.items) || typeof payload.completed_sessions !== 'number') {
          setChildProgress({ athleteId: activeChildId, state: 'failed' });
          return;
        }
        setChildProgress({
          athleteId: activeChildId,
          state: 'loaded',
          milestonesEarned: earnedMilestoneKeys({
            completedSessions: payload.completed_sessions,
            awardedKeys: payload.items
              .map((item) => (item as { milestone_key?: unknown } | null)?.milestone_key)
              .filter((key): key is string => typeof key === 'string'),
          }).length,
          sessionsCompleted: payload.completed_sessions,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setChildProgress({ athleteId: activeChildId, state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [activeChildId]);
  const shownProgress = childProgress?.athleteId === activeChildId ? childProgress : null;
  const progressText = shownProgress?.state === 'loaded'
    ? `${shownProgress.milestonesEarned} ${shownProgress.milestonesEarned === 1 ? 'milestone' : 'milestones'} earned · ${shownProgress.sessionsCompleted} ${shownProgress.sessionsCompleted === 1 ? 'session' : 'sessions'} logged`
    : 'Unavailable';

  const activeChild = children.find(c => c.id === activeChildId);

  /* PARENT FLOOR TASKS (WO-PH-02). The selected child's parent-support tasks,
     cut from the one messages read the Messages tab and the Home Tasks tile
     also use, so a tick in either place moves all three. "This week" is every
     task due in the gym's current week, done or not; "Still open" is every
     unticked task due before it or with no due date, so an unfinished task
     does not drop out because Sunday passed (Q1 = B), plus any of those ticked
     on this visit. A task ticked off on an earlier visit, or due after this
     week, is on Messages. */
  /* No child selected (the roster failed or is still loading) is an unknown,
     not an empty week: the card says it cannot show the list. */
  const weekBounds = messagesLoaded && activeChildId ? gymWeekBounds(floorClockMs) : null;
  const activeChildTasks = messages.filter((message) => message.athlete_id === activeChildId && message.task !== null);
  const byDueDate = (a: ParentMessage, b: ParentMessage) =>
    (a.task?.due_date ?? '').localeCompare(b.task?.due_date ?? '');
  const thisWeekTasks = weekBounds
    ? activeChildTasks
      .filter((message) => {
        const due = message.task?.due_date;
        return isCalendarDay(due) && due >= weekBounds.start && due <= weekBounds.end;
      })
      .sort(byDueDate)
    : [];
  const earlierOpenTasks = weekBounds
    ? activeChildTasks
      .filter((message) => {
        const due = message.task?.due_date ?? null;
        const before = !isCalendarDay(due) || due < weekBounds.start;
        return before && (isOpenTask(message) || tasksTouched.has(message.note_id));
      })
      // Dated ones oldest first; undated after them.
      .sort((a, b) => {
        const dueA = a.task?.due_date ?? null;
        const dueB = b.task?.due_date ?? null;
        if (dueA === null || dueB === null) return dueA === dueB ? 0 : dueA === null ? 1 : -1;
        return dueA.localeCompare(dueB);
      })
    : [];
  const thisWeekDone = thisWeekTasks.filter((message) => !isOpenTask(message)).length;
  // Only the card that was read for the child now selected. See the note on
  // the childCard state for why the match happens here.
  const shownCard = childCard.athleteId === activeChildId ? childCard.card : null;
  /* Per-child views of the one family-scoped read above. The server already
     refused every athlete this guardian does not hold; this narrows to the
     child on screen. */
  const schedulerClassById = new Map(schedulerFeed.classes.map((row) => [row.class_id, row]));

  const activeAttendanceEntries: AttendanceEntry[] = schedulerFeed.attendance
    .filter((row) => row.athlete_id === activeChildId)
    // Newest first. checked_in_at is an ISO-8601 timestamptz, so a string
    // comparison IS a chronological one, and avoids minting Date objects for
    // a sort that only needs an ordering.
    .slice()
    .sort((a, b) => b.checked_in_at.localeCompare(a.checked_in_at))
    .map((row) => ({
      id: row.attendance_id,
      childId: row.athlete_id,
      date: formatGymDateTimeShort(row.checked_in_at) ?? row.checked_in_at,
      // A class can be removed while its attendance rows survive. Saying so is
      // better than rendering a bare id or, worse, dropping the row -- the
      // child was there, and that fact does not stop being true.
      session: schedulerClassById.get(row.class_id)?.title ?? 'Session no longer listed',
      status: row.status === 'present' ? 'Present' : row.status === 'excused' ? 'Excused' : 'Absent',
    }));

  /* PARSED, NOT COMPARED AS TEXT. start_at arrives as Postgres timestamptz
     text ('2026-10-08 18:00:00+00'), and the old compare held it against
     new Date().toISOString() ('2026-10-08T17:00:00.000Z') as strings: the
     space sorts before the 'T', so every class on today's date read as
     already past, and the format of either side could change the answer.
     Date.parse reads both. A start that will not parse is not shown as
     upcoming: nothing can say when it is. "Now" is the moment the feed
     landed: the page reads one schedule and judges it against one clock. */
  const nowMs = schedulerFeed.readAtMs;
  const startMs = (klass: SchedulerFeedClass): number => Date.parse(klass.start_at);
  const activeUpcomingSessions: UpcomingSession[] = schedulerFeed.registrations
    .filter((row) => row.athlete_id === activeChildId && row.status !== 'cancelled')
    .map((row) => ({ registration: row, klass: schedulerClassById.get(row.class_id) }))
    // A cancelled class is not upcoming, and a registration whose class this
    // guardian cannot see is not something to render half of.
    .filter((pair) => pair.klass !== undefined && pair.klass.status !== 'cancelled' && startMs(pair.klass) > nowMs)
    .sort((a, b) => startMs(a.klass as SchedulerFeedClass) - startMs(b.klass as SchedulerFeedClass))
    .map(({ registration, klass }) => ({
      id: registration.registration_id,
      date: formatGymDateTimeShort((klass as SchedulerFeedClass).start_at) ?? (klass as SchedulerFeedClass).start_at,
      title: (klass as SchedulerFeedClass).title,
      location: (klass as SchedulerFeedClass).location,
      // Waitlisted is not a place. A guardian who reads "registered" and turns
      // up to find their kid was never in the class has been misled by this
      // panel, so the standing is shown rather than flattened away.
      standing: registration.status === 'waitlisted' ? 'Waitlisted' : 'Registered',
    }));
  /* The summary's attendance figures count the rows the Attendance tab lists
     for the same child, from the same read. Neither figure exists until that
     read answered AND a child is selected: a schedule still loading is not
     zero sessions, and neither is a schedule filtered against no child (the
     roster read can land after the schedule, or fail). */
  // Newest first, so the head of the list is the last mark written. "Marked",
  // not "attended": checked_in_at is when the mark was written or re-written.
  const lastAttendanceMark = activeAttendanceEntries[0] ?? null;
  const activeAttendanceTally = schedulerFeedState === 'loaded' && activeChildId
    ? {
      present: activeAttendanceEntries.filter((entry) => entry.status === 'Present').length,
      excused: activeAttendanceEntries.filter((entry) => entry.status === 'Excused').length,
      absent: activeAttendanceEntries.filter((entry) => entry.status === 'Absent').length,
      lastMarked: lastAttendanceMark?.date ?? null,
    }
    : null;
  // A waitlist is not a place, so this count differs from the tab's Upcoming
  // Sessions list by the waitlisted rows the tab shows marked as such. Judged
  // against the clock reading taken when the schedule landed, like the list.
  const activeUpcomingPlaces = schedulerFeedState === 'loaded' && activeChildId
    ? activeUpcomingSessions.filter((session) => session.standing === 'Registered').length
    : null;
  /* The selected child's parent-support tasks, done of all set so far, for
     the Progress tab's summary, from the messages read: reading while that
     read is out, Unavailable when it failed. */
  const activeSupportTasks: SupportTasks = messagesLoaded
    ? (() => {
      const tasks = messages.filter((message) => message.athlete_id === activeChildId && message.task !== null);
      return { state: 'loaded', done: tasks.filter((message) => !isOpenTask(message)).length, total: tasks.length };
    })()
    : messagesFailed ? { state: 'failed' } : { state: 'loading' };

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

  /* One parent-support task on the Parent Floor: the coach's words, when it is
     due, and the same Done box the Messages tab carries, through the same
     handleTaskToggle -- the box shows what the server holds. */
  function renderParentTask(message: ParentMessage) {
    const task = message.task;
    if (!task) return null;
    const done = task.completed_at !== null;
    return (
      <li key={message.note_id} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
        <p className="t-body" id={`floor-task-${message.note_id}`}>{message.note_text}</p>
        <p className="t-muted mt-[var(--s2)]">
          {`From ${message.sender_role === 'coach' ? 'Coach' : 'Admin'} · ${task.due_date ? `Due ${isCalendarDay(task.due_date) ? formatDueDate(task.due_date) : task.due_date}` : 'No due date'}`}
        </p>
        <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
          <label className="inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s2)]">
            <input
              type="checkbox"
              className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
              checked={done}
              aria-describedby={`floor-task-${message.note_id}`}
              disabled={taskBusy.has(message.note_id)}
              onChange={(event) => void handleTaskToggle(message.note_id, event.target.checked)}
            />
            <span className="t-body">
              {done ? `Done ${formatGymDateTimeShort(task.completed_at) ?? ''}`.trim() : 'Done'}
            </span>
          </label>
          {!done && <span className="t-muted">Still to do</span>}
        </div>
      </li>
    );
  }

  return (
    /* Family-facing surface — the warm canvas ground itself (Law 6), stated on
       the full-bleed wrapper so every component inside restates for cream. */
    <div className="ge-family on-canvas min-h-screen rounded-[var(--r-lg)] font-sans text-[color:var(--hide-900)]">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        {/* HEADER */}
        <div className="border-b-2 border-[color:var(--brass-700)] pb-[var(--s5)] space-y-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Parent Support Hub</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'clamp(var(--t-lg), 8vw, var(--t-2xl))' }}>Family Development Dashboard</h1>
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
            athlete or coach workspace still do not.
            Labelled as posted for every family, so a guardian never takes it
            for a message written to them; those are on the Messages tab
            (#1542, FC-07; Q-1 A: announcements stay out of the message
            history). */}
        <AnnouncementBanner
          placement="parent_hub"
          kind="notice"
          heading="Gym announcements"
          note="Posted for every family at the gym, not a message to you."
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

        {/* ROLE SUMMARY PANEL. Progress, Upcoming and Attendance are the
            selected child's; Home Tasks and Messages count across every
            child. Each tile is Unavailable until the read it counts from has
            answered, never 0: a derived 0 would tell a parent "nothing is
            scheduled" or "nothing is due", which nobody verified. */}
        <ParentSummaryPanel
          childProgress={progressText}
          tasksDue={messagesLoaded ? messages.filter(isOpenTask).length : null}
          upcomingEvents={activeUpcomingPlaces}
          attendance={activeAttendanceTally}
          unreadMessages={messagesLoaded ? messages.length : null}
        />

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
                type="button"
                onClick={() => setActiveChildId(child.id)}
                aria-pressed={activeChildId === child.id}
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
        <div className="ge-family__rail mat-paper rounded-[var(--r-md)]">
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
                type="button"
                onClick={() => setActiveTab(tab.id as TabID)}
                aria-pressed={activeTab === tab.id}
                aria-current={activeTab === tab.id ? 'true' : undefined}
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
                    View Messages from the Coaches
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
                  <Link href="/parent/video" className="btn btn--ghost w-full">
                    Your athlete&apos;s film
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

              {shownBodyMass && (
                <div className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]" data-testid="parent-body-mass">
                  <p className="t-label">Body mass</p>
                  <p className="t-body mt-[var(--s2)]">
                    {shownBodyMass.pounds} lb, logged {formatGymDateNumeric(shownBodyMass.observedAt)}.
                  </p>
                  {shownBodyMass.flagText && (
                    <p className="t-body mt-[var(--s2)] font-semibold" role="status">{shownBodyMass.flagText}</p>
                  )}
                </div>
              )}

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
                        <p className="t-body font-semibold">{progressText}</p>
                      </div>
                      <div>
                        <p className="t-label mb-[var(--s2)]">Attendance</p>
                        {activeAttendanceTally ? (
                          <>
                            <p className="t-body font-semibold">
                              {`Present ${activeAttendanceTally.present} · Excused ${activeAttendanceTally.excused} · Absent ${activeAttendanceTally.absent}`}
                            </p>
                            {lastAttendanceMark ? (
                              <p className="t-muted">{`Last marked ${lastAttendanceMark.date}`}</p>
                            ) : null}
                          </>
                        ) : (
                          <p className="t-body font-semibold">Unavailable</p>
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
                description="The things your child's coach has asked you to do, and a way to tell the coach what is getting in the way."
                usage={[
                  'Review what the gym has asked of you this week',
                  'Tick a task Done when it is done (a wrong tick can be unticked)',
                  'Check what is still open from earlier weeks',
                  'Report a barrier at home or with getting here'
                ]}
                mistakes={[
                  'Leaving a finished task unticked, so it keeps showing as open',
                  'Waiting until the due date to say something is in the way'
                ]}
              />

              {/* #95/#96: the guardian's barrier report. */}
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
                {!weekBounds ? (
                  <p className="t-muted">
                    Unavailable - your tasks could not be shown. This is not an empty list.
                  </p>
                ) : (
                  <>
                    <p className="t-body">
                      {thisWeekTasks.length === 0
                        ? `Nothing from the gym is due this week (${formatDueDate(weekBounds.start)} to ${formatDueDate(weekBounds.end)}).`
                        : `${thisWeekDone} of ${thisWeekTasks.length} done this week (${formatDueDate(weekBounds.start)} to ${formatDueDate(weekBounds.end)}).`}
                    </p>
                    {taskNotice && taskNotice.athleteId === activeChildId && (
                      <p role="alert" className="t-body font-bold text-[var(--restricted-ink)]">{taskNotice.text}</p>
                    )}
                    {thisWeekTasks.length > 0 && (
                      <ul className="space-y-[var(--s3)]" aria-label="Due this week">
                        {thisWeekTasks.map((message) => renderParentTask(message))}
                      </ul>
                    )}
                    {earlierOpenTasks.length > 0 && (
                      <>
                        <h4 className="t-label">Still open: earlier or no due date</h4>
                        <ul className="space-y-[var(--s3)]" aria-label="Still open: earlier or no due date">
                          {earlierOpenTasks.map((message) => renderParentTask(message))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* HOME ASSIGNMENTS */}
          {activeTab === 'home-assignments' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Home Assignments"
                description="What your child's coach has set them to work on: drills, and workouts in the coach's order."
                usage={[
                  'Review what is being worked on now and when it is due',
                  'Make time and space for the practice at home',
                  'Open the full progression record for the logged work'
                ]}
                mistakes={[
                  'Missing a due date',
                  'Not asking the coach when a drill is unclear'
                ]}
              />

              {activeChildId ? (
                <ParentAssignmentList athleteId={activeChildId} />
              ) : (
                <p className="t-muted">Unavailable - no child selected.</p>
              )}
            </div>
          )}

          {/* OBSERVATIONS */}
          {activeTab === 'observations' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Parent Observations"
                description="Write down what you notice at home -- energy, motivation, sleep and recovery, how they are developing -- and it is saved to your child's record at the gym, where the coaches can read it."
                usage={[
                  'Pick what it is about and say what you noticed',
                  'Add a rating from 1 to 10 if it helps; it is optional',
                  'Look back at what you have written',
                  'Something the coach needs to know now: use Report a Barrier on the Parent Floor, or speak to the coach'
                ]}
                mistakes={[
                  'Not mentioning a change because it seems small',
                  'Leaving out the good weeks as well as the hard ones'
                ]}
              />

              {activeChildId ? (
                <ParentObservations key={activeChildId} athleteId={activeChildId} />
              ) : (
                <p className="t-muted">Unavailable - no child selected.</p>
              )}
            </div>
          )}

          {/* FAMILY GOALS */}
          {activeTab === 'family-goals' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Family Goals"
                description="Goals your family sets to support your child. Each says what the family will do; it shows Done with the date it was ticked, or In progress."
                usage={[
                  'Add a goal: what you are aiming for and what the family will do',
                  'Tick Done when it is done; untick it if it was ticked by mistake',
                  'Edit or retire a goal you set'
                ]}
                mistakes={[
                  'Writing a goal without what the family will actually do',
                  'Leaving a finished goal unticked'
                ]}
              />

              {/* #1593 PH-06: built, so F-019's "not built yet" note goes.
                  Per child (key), like Observations. */}
              {activeChildId ? (
                <ParentFamilyGoals key={activeChildId} athleteId={activeChildId} />
              ) : (
                <p className="t-muted">Unavailable - no child selected.</p>
              )}
            </div>
          )}

          {/* MESSAGES */}
          {activeTab === 'messages' && (
            <div className="space-y-6 panel-settle">
              <HelpPanel
                title="Messages from the coaches"
                description="Each message here was written by a coach or the gym's staff to your family, about your child. Gym-wide announcements are not messages; they sit at the top of the hub."
                usage={[
                  'Read each message the coaches wrote to your family',
                  'Reply under a message to answer the gym',
                  'Tick a to-do as Done when it is done',
                  'Share what you see at home on the Observations tab'
                ]}
                mistakes={[
                  'Looking here for gym-wide announcements (they are at the top of the hub)',
                  'Leaving a to-do unticked after it is done'
                ]}
              />

              {/* What this tab holds, always on screen (FC-07): only what was
                  written to this family; gym announcements are not here. */}
              <p className="t-body">
                What the coaches and gym staff wrote to your family about your child. You can reply under a message. Gym announcements for every family are at the top of the hub.
              </p>

              {/* A read that did not answer is not an empty inbox.
                  `messagesLoaded` stays false when /api/pilot/parent/messages
                  did not answer, and this tab used to render that as "No
                  messages yet." -- which tells a guardian the gym has written
                  nothing to them, as a fact, when nobody knows. The summary
                  tile above already made this distinction (it renders
                  Unavailable); the tab did not, and the tab is what a guardian
                  opens to read their messages.

                  Worded to be true in BOTH unanswered states. This flag does
                  not separate "still in flight" from "refused", and the fetch
                  starts when the hub mounts rather than when this tab opens,
                  so a guardian who taps Messages quickly is looking at a read
                  that has not come back yet -- "could not be loaded" would
                  claim a failure nobody has observed either. "Unavailable" is
                  the tile's own word for exactly this, and it covers both. */}
              {taskNotice && (
                <p role="alert" className="t-body font-bold text-[var(--restricted-ink)]">{taskNotice.text}</p>
              )}

              {repliesFailed && messagesLoaded && messages.length > 0 && (
                <p className="t-muted">Your earlier replies have not loaded. This is not a statement that you have not replied.</p>
              )}

              {!messagesLoaded ? (
                <p className="t-muted">Unavailable - your messages have not loaded. This is not an empty inbox.</p>
              ) : messages.length === 0 ? (
                <p className="t-muted">No messages yet.</p>
              ) : (
                <div className="space-y-[var(--s4)]">
                  {messages.map((message) => (
                    <div key={message.note_id} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                      {/* What counts as opening it is the message itself, not
                          the replies and reply box under it: a long thread must
                          not keep the card from ever being half on screen. */}
                      <div data-read-note={message.note_id}>
                        <div className="flex justify-between items-start gap-[var(--s3)] mb-[var(--s3)]">
                          <h4 className="t-body font-semibold">{message.athlete_name ?? 'Your child'}</h4>
                          <span className="t-label">From {message.sender_role === 'coach' ? 'Coach' : 'Admin'}</span>
                        </div>
                        <p className="t-body mb-[var(--s3)]">{message.note_text}</p>
                      </div>
                      <p className="t-muted">{formatGymDateTimeShort(message.created_at) ?? message.created_at}</p>
                      {/* A message with a due date is something to do. The box
                          is the guardian's one write here; "Done" / "Still to
                          do" is printed beside it so the state is never the
                          tick mark alone. */}
                      {message.task && (
                        <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)] border-t border-[color:rgba(0,0,0,.14)] pt-[var(--s3)]">
                          <span className="t-body font-semibold">
                            {message.task.due_date ? `Due ${formatDueDate(message.task.due_date)}` : 'To do'}
                          </span>
                          <label className="inline-flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s2)]">
                            <input
                              type="checkbox"
                              className="h-[var(--s5)] w-[var(--s5)] accent-[var(--brass-600)]"
                              checked={message.task.completed_at !== null}
                              disabled={taskBusy.has(message.note_id)}
                              onChange={(event) => void handleTaskToggle(message.note_id, event.target.checked)}
                            />
                            <span className="t-body">
                              {message.task.completed_at !== null
                                ? `Done ${formatGymDateTimeShort(message.task.completed_at) ?? ''}`.trim()
                                : 'Done'}
                            </span>
                          </label>
                          {message.task.completed_at === null && <span className="t-muted">Still to do</span>}
                        </div>
                      )}
                      {/* Replies: this guardian's own, oldest first, then a box
                          for another. Staff read them under the note. */}
                      <div className="mt-[var(--s3)] space-y-[var(--s2)] border-t border-[color:rgba(0,0,0,.14)] pt-[var(--s3)]">
                        {ownReplies
                          .filter((reply) => reply.note_id === message.note_id)
                          .map((reply) => (
                            <div key={reply.reply_id} className="rounded-[var(--r-sm)] bg-[color:rgba(0,0,0,.05)] p-[var(--s2)]">
                              <p className="t-label">You replied · {formatGymDateTimeShort(reply.created_at) ?? reply.created_at}</p>
                              <p className="t-body whitespace-pre-wrap">{reply.reply_text}</p>
                            </div>
                          ))}
                        {/* Each box and button says which message it answers, for a
                            screen reader reading several in a row. */}
                        <label className="t-label block" htmlFor={`reply-${message.note_id}`}>
                          Your reply
                          <span className="sr-only">
                            {` to the message about ${message.athlete_name ?? 'your child'}, ${formatGymDateTimeShort(message.created_at) ?? message.created_at}`}
                          </span>
                        </label>
                        <textarea
                          id={`reply-${message.note_id}`}
                          value={replyDrafts[message.note_id] ?? ''}
                          onChange={(event) => {
                            const value = event.target.value;
                            setReplyDrafts((held) => ({ ...held, [message.note_id]: value }));
                          }}
                          className="textarea h-20 resize-y"
                        />
                        {replyNotices[message.note_id] ? (
                          <p role="alert" className="t-body font-bold text-[var(--restricted-ink)]">{replyNotices[message.note_id]}</p>
                        ) : null}
                        <button
                          type="button"
                          className="btn"
                          disabled={replyBusy.has(message.note_id) || !(replyDrafts[message.note_id] ?? '').trim()}
                          onClick={() => void handleSendReply(message.note_id)}
                        >
                          {replyBusy.has(message.note_id) ? 'Sending…' : 'Send reply'}
                          <span className="sr-only">{` about ${message.athlete_name ?? 'your child'}`}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

            </div>
          )}

          {/* ATTENDANCE */}
          {activeTab === 'attendance' && (
            <div className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)] panel-settle">
              <h3 className="t-label">Attendance Tracking</h3>
              <p className="t-body">Attendance history and upcoming sessions, from the gym schedule.</p>

              {/* THREE STATES, KEPT APART. A failed read is not an empty
                  record and an empty record is not a zero: a guardian who is
                  told "no sessions" when the truth is "we could not ask" has
                  been given a fact that was never observed. Each branch below
                  says only what it knows. */}
              <div className="space-y-[var(--s3)]">
                {schedulerFeedState === 'loading' && <p className="working">Reading the schedule</p>}

                {/* alert--warning, not alert--critical. alert--critical wears
                    --locked, which means the top of the safety ladder -- a
                    person who may not participate -- and a schedule that would
                    not load is not that. Putting the medical stop on a failed
                    fetch is what makes it stop meaning anything when a real
                    participation block needs it. (Red itself is not reserved,
                    OD-2026-09-29-001.) */}
                {schedulerFeedState === 'failed' && (
                  <div className="alert alert--warning alert--tight" role="alert">
                    Unavailable - the schedule could not be read. This is not an empty attendance record.
                  </div>
                )}

                {schedulerFeedState === 'loaded' && activeAttendanceEntries.length === 0 && (
                  <p className="t-body">No attendance recorded for this athlete yet.</p>
                )}

                {schedulerFeedState === 'loaded' && activeAttendanceEntries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
                    <div>
                      <p className="t-body font-semibold">{entry.date} | {entry.session}</p>
                    </div>
                    {/* The glyph is aria-hidden and the word carries the
                        meaning, so status is never colour-only. */}
                    <span className={`text-[length:var(--t-sm)] font-semibold uppercase ${attendanceStatusTone(entry.status)}`}>
                      <span aria-hidden="true">{attendanceGlyph(entry.status)}</span> {entry.status}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)] space-y-[var(--s3)]">
                <h4 className="t-body font-semibold">Upcoming Sessions</h4>

                {schedulerFeedState === 'loading' && <p className="working">Reading the schedule</p>}

                {schedulerFeedState === 'failed' && (
                  <p className="t-body">Unavailable - the schedule could not be read.</p>
                )}

                {schedulerFeedState === 'loaded' && activeUpcomingSessions.length === 0 && (
                  <p className="t-body">No upcoming sessions this athlete is registered for.</p>
                )}

                {schedulerFeedState === 'loaded' && activeUpcomingSessions.map((session) => (
                  <div key={session.id} className="t-body">
                    <p><strong>{session.date}</strong> - {session.title}</p>
                    <p>{session.location} | {session.standing}</p>
                  </div>
                ))}

                <p className="t-body">
                  <Link href="/schedule">Open the full scheduler</Link> to register, review a registration, or
                  check an athlete in.
                </p>
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

              {/* The goals the child set, their reported progress and the ones
                  they marked done (lane N8-05). Read-only; the reason line
                  each goal carries is the coach's and never reaches here. */}
              {activeChildId && (
                <AthleteGoalsReadOnly key={activeChildId} athleteId={activeChildId} audience="family" />
              )}

              {activeChildId ? (
                <ParentProgressSummary athleteId={activeChildId} supportTasks={activeSupportTasks} />
              ) : childrenLoading ? (
                <p className="working">Reading...</p>
              ) : (
                <>
                  <p className="t-muted">Unavailable - no child selected.</p>
                  <Link href="/parent/progression-visibility" className="btn btn--ghost">
                    Open the full progression record
                  </Link>
                </>
              )}
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

