'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
// A plain constant with no server dependencies, so a client component can
// import it and the admin copy can never drift from what the server sets.
import { DEFAULT_FIRST_LOGIN_PIN } from '@/src/server/pilot/pinPolicy';

interface Member {
  account_id: string;
  login_email: string | null;
  auth_provider: 'ppbf_local' | 'microsoft';
  role: string;
  athlete_id: string | null;
  active_flag: boolean;
  has_pin: boolean;
  membership_active: boolean;
}

/** A row of pilot.athletes, with the login account joined on if it has one. */
interface RosterAthlete {
  athlete_id: string;
  full_name: string;
  /** ISO date. Optional so an older payload without it degrades to a name-only caution. */
  dob?: string;
  account_id: string | null;
  account_active: boolean | null;
  has_pin: boolean;
  account_updated_at: string | null;
}

/**
 * One guardian-to-athlete link. This is what a parent account actually reads
 * through — a parent with no link signs in and resolves no children — so it is
 * shown on the row rather than left for the family to discover.
 */
interface GuardianLink {
  account_id: string;
  parent_id: string;
  athlete_id: string;
  athlete_full_name: string;
  relationship_to_athlete: string;
}

type Tab = 'people' | 'invite-staff' | 'add-athlete';

/**
 * The two genuinely different jobs behind "add an athlete". They were
 * previously collapsed into one form that only did `existing`, which is why an
 * admin adding their first athlete hit "Athlete not found in organization" —
 * there was no surface anywhere that created the roster record itself.
 */
type AthleteMode = 'new' | 'existing';

const STAFF_ROLES = [
  { value: 'coach', label: 'Coach', blurb: 'Works with assigned athletes; sees their sessions and notes.' },
  { value: 'staff', label: 'Staff', blurb: 'General gym staff without coaching assignments.' },
  { value: 'volunteer', label: 'Volunteer', blurb: 'Limited helper access.' },
  {
    value: 'parent',
    label: 'Parent / Guardian',
    blurb: 'Sees only the athletes you link them to below, and nothing else in the gym.',
  },
];

/**
 * pilot.guardian_links.relationship_to_athlete is plain `text`, so the
 * vocabulary is convention. A fixed list keeps the intake path and this form
 * writing the same words for the same relationship, and "Other" carries the
 * cases a list cannot anticipate without inviting free text everywhere.
 */
const GUARDIAN_RELATIONSHIPS = [
  { value: 'mother', label: 'Mother' },
  { value: 'father', label: 'Father' },
  { value: 'guardian', label: 'Legal guardian' },
  { value: 'grandparent', label: 'Grandparent' },
  { value: 'other', label: 'Other family member' },
];

const ATHLETE_MODES: Array<{ value: AthleteMode; label: string; blurb: string }> = [
  {
    value: 'new',
    label: 'New to the gym',
    blurb: 'Nobody has entered them anywhere yet. Creates their roster record and their sign-in together.',
  },
  {
    value: 'existing',
    label: 'Already on the roster',
    blurb: 'Their record already exists — promoted from an intake application, say — and they only need a way to sign in.',
  },
];

/**
 * pilot.athletes.gym_status is plain `text` with no database constraint, so
 * the vocabulary is only held together by convention. These are the values the
 * seed importer documents and the gate scripts write, and the coach workspace
 * displays gym_status verbatim as an athlete's track — a free-text box here
 * would fragment all three.
 */
const GYM_STATUS_OPTIONS = [
  { value: 'active', label: 'Active — training and competing' },
  { value: 'training', label: 'Training — in the gym, not competing yet' },
  { value: 'inactive', label: 'Inactive — on the roster but not attending' },
];

function roleLabel(role: string): string {
  if (role === 'organization_admin' || role === 'admin') return 'Gym Admin';
  if (role === 'platform_owner') return 'Platform Owner';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Describes whether a person can actually sign in AND see the thing their role
 * exists for, which is the question an admin is really asking when they look
 * at this list. A row can exist and still be unusable in several very
 * different ways, and they have different fixes.
 *
 * A guardian is the case worth spelling out: a parent account signs in
 * perfectly well with no guardian link and then resolves no children, so
 * "Signs in with Microsoft" alone would describe a working account that shows
 * a family an empty page.
 *
 * `guardianLinkCount` is null when the guardian links could not be read at
 * all, which is reported as unknown rather than as zero.
 */
function signInStatus(
  member: Member,
  guardianLinkCount: number | null,
): { label: string; tone: 'ok' | 'pending' | 'blocked' } {
  if (!member.active_flag || !member.membership_active) {
    return { label: 'Deactivated', tone: 'blocked' };
  }

  if (member.role === 'parent') {
    if (guardianLinkCount === null) {
      return { label: 'Guardian links could not be read', tone: 'pending' };
    }
    if (guardianLinkCount === 0) {
      return { label: 'Linked to no athlete — would see nothing', tone: 'blocked' };
    }
  }

  if (member.auth_provider === 'microsoft') {
    return { label: 'Signs in with Microsoft', tone: 'ok' };
  }

  if (!member.has_pin) {
    return { label: 'Has not set a PIN yet', tone: 'pending' };
  }

  return { label: 'PIN set', tone: 'ok' };
}

/**
 * Shown when someone reaches this page whose role cannot use it -- in
 * practice a platform owner arriving by bookmark or typed URL, since the
 * header entry point is hidden for them.
 *
 * Every route behind this console is organization-scoped and rejects a
 * platform owner by design: managing a gym's roster belongs to that gym's
 * admin. Rather than let the roster fetch fail with a bare "Forbidden", say
 * why and point at the surface that does the caller's job.
 */
function WrongRoleNotice() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
      <div className="mx-auto max-w-xl space-y-5 text-center">
        <p className="text-xs font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">Different Console</p>
        <h1 className="font-display text-3xl font-black">People is managed per gym</h1>
        <p className="text-sm leading-7 text-[var(--gray-dark)]">
          This console belongs to a gym admin — it manages one organization&apos;s coaches, staff, and athletes. As
          platform owner you create organizations and appoint their admins, and they take it from there.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/admin/organizations"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-6 text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-[var(--red-highlight)]"
          >
            Organization Provisioning
          </Link>
          <Link
            href="/admin"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)]"
          >
            Admin Home
          </Link>
        </div>
      </div>
    </main>
  );
}

function PeopleConsoleContent() {
  const [tab, setTab] = useState<Tab>('people');
  const [members, setMembers] = useState<Member[]>([]);
  const [guardianLinks, setGuardianLinks] = useState<GuardianLink[]>([]);
  // Distinct from an empty list: the roster read can succeed while the
  // guardian links are absent, and "no links returned" must never be shown as
  // "this guardian is linked to nobody".
  const [guardianLinksAvailable, setGuardianLinksAvailable] = useState(false);
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Invite staff form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('coach');

  // Guardian half of a parent invite. The server refuses the parent role
  // without all three, because the account is only useful attached to a child.
  const [guardianFullName, setGuardianFullName] = useState('');
  const [guardianAthleteId, setGuardianAthleteId] = useState('');
  const [guardianRelationship, setGuardianRelationship] = useState(GUARDIAN_RELATIONSHIPS[0].value);

  // Which guardian link the admin has asked to remove, held so the removal
  // needs a second, explicit confirmation on the row itself.
  const [pendingUnlink, setPendingUnlink] = useState<{ accountId: string; athleteId: string } | null>(null);

  // Add athlete form. account_id and athlete_id are shared by both modes; the
  // rest of the roster fields are only sent when creating a new record.
  const [athleteMode, setAthleteMode] = useState<AthleteMode>('new');
  const [athleteAccountId, setAthleteAccountId] = useState('');
  const [athleteId, setAthleteId] = useState('');
  // Whether the admin has typed in the record ID themselves. Once they have,
  // the suggestion below stops overwriting it -- a field that keeps
  // re-populating while you are editing it is worse than one that never did.
  const [athleteIdEdited, setAthleteIdEdited] = useState(false);
  // Set only by the admin ticking past the duplicate-child warning. Never
  // defaulted true and cleared whenever the form resets, so the tick applies
  // to the one child it was read for.
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [athleteFullName, setAthleteFullName] = useState('');
  const [athleteDob, setAthleteDob] = useState('');
  const [athleteWeightClass, setAthleteWeightClass] = useState('');
  const [athleteGymStatus, setAthleteGymStatus] = useState(GYM_STATUS_OPTIONS[0].value);
  const [athleteEmergencyContact, setAthleteEmergencyContact] = useState('');
  // Starts empty so nothing is submitted until a real coach is chosen:
  // pilot.athletes.coach_id is `not null` and carries a foreign key to
  // pilot.accounts, so any placeholder token is rejected by the database as
  // a foreign key violation, which surfaces only as an opaque 500.
  const [athleteCoachId, setAthleteCoachId] = useState('');

  // Which athlete_id already has its roster record written server-side by this
  // form. Creating an athlete is two writes against two routes, and the second
  // one can fail on its own (a taken sign-in ID, say). Remembering the first
  // write means the retry links the record it already made instead of
  // re-posting it and tripping the duplicate check.
  const [rosterCreatedFor, setRosterCreatedFor] = useState('');

  // The just-created account, so the confirmation panel can tell the admin
  // exactly what to say to the athlete. Nothing secret lives here -- the
  // starting PIN is the same for everyone and is safe to re-display.
  const [createdAthlete, setCreatedAthlete] = useState<{ accountId: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [membersResponse, rosterResponse] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/admin/staff`, { method: 'GET', credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/admin/athlete-pin-directory`, { method: 'GET', credentials: 'include' }),
      ]);

      const membersPayload = (await membersResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: Member[];
        guardian_links?: GuardianLink[];
        organization_id?: string;
        error?: string;
      };

      if (!membersResponse.ok || !membersPayload.ok) {
        throw new Error(membersPayload.error || 'Unable to load your gym roster');
      }

      setMembers(membersPayload.members || []);
      setOrganizationId(membersPayload.organization_id || '');

      // Only an actual array counts as an answer. Anything else leaves every
      // parent row reporting that the links are unknown, which is the truth.
      if (Array.isArray(membersPayload.guardian_links)) {
        setGuardianLinks(membersPayload.guardian_links);
        setGuardianLinksAvailable(true);
      } else {
        setGuardianLinks([]);
        setGuardianLinksAvailable(false);
      }

      // The roster directory is what lets an admin pick an existing athlete
      // instead of typing an id from memory, and it is also how this page
      // catches an athlete_id collision before the create is sent. If it is
      // unavailable the tab degrades to a text box rather than losing the
      // ability to add anyone.
      const rosterPayload = (await rosterResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        items?: RosterAthlete[];
      };
      if (rosterResponse.ok && rosterPayload.ok) {
        setRoster(rosterPayload.items || []);
        setRosterAvailable(true);
      } else {
        setRosterAvailable(false);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your gym roster');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const pendingAthletes = useMemo(
    () => members.filter((member) => member.auth_provider === 'ppbf_local' && !member.has_pin),
    [members],
  );

  const coachOptions = useMemo(
    () => members.filter((member) => member.role === 'coach' && member.active_flag && member.membership_active),
    [members],
  );

  // Athletes on the roster with no login yet — exactly the population path (B)
  // exists to serve, and the reason it can be a picker instead of a text box.
  const unlinkedAthletes = useMemo(() => roster.filter((athlete) => !athlete.account_id), [roster]);

  const guardianLinksByAccount = useMemo(() => {
    const byAccount = new Map<string, GuardianLink[]>();
    for (const link of guardianLinks) {
      const existing = byAccount.get(link.account_id);
      if (existing) {
        existing.push(link);
      } else {
        byAccount.set(link.account_id, [link]);
      }
    }
    return byAccount;
  }, [guardianLinks]);

  const strandedGuardians = useMemo(
    () =>
      guardianLinksAvailable
        ? members.filter(
            (member) =>
              member.role === 'parent'
              && member.active_flag
              && member.membership_active
              && !guardianLinksByAccount.has(member.account_id),
          )
        : [],
    [guardianLinksAvailable, guardianLinksByAccount, members],
  );

  /**
   * Why a parent cannot be invited right now, or null when they can.
   *
   * A guardian link points at one athlete record, and picking the wrong child
   * hands an adult another family's records. So the choice is made from the
   * roster the server returned or not at all — never from an id typed blind
   * against a roster this page could not read.
   */
  const parentInviteBlockedReason = !rosterAvailable
    ? 'Your gym roster could not be read, so there is no verified list of athletes to link a guardian to. Reload this page and try again.'
    : roster.length === 0
      ? 'There are no athlete records in your gym yet. Add the athlete first, then invite their guardian.'
      : null;

  const rosterById = useMemo(() => new Map(roster.map((athlete) => [athlete.athlete_id, athlete])), [roster]);

  /**
   * The next free `ath-NNN`, or '' when one cannot be offered safely.
   *
   * Returns '' if the roster could not be read. A suggestion computed against
   * a roster this page cannot see is a suggestion that may already belong to
   * an athlete -- and the collision warning below is blind in exactly the same
   * situation, so the admin would get a prefilled ID with nothing to catch it.
   * Typing it by hand is the honest fallback.
   *
   * Ids the gym numbers some other way are simply skipped by the pattern, and
   * the final loop makes the result safe regardless: whatever the scan
   * produces, it is walked forward until it hits an id nobody holds.
   */
  const suggestedAthleteId = useMemo(() => {
    if (!rosterAvailable) {
      return '';
    }

    let highest = 0;
    for (const athlete of roster) {
      const match = /^ath-(\d+)$/.exec(athlete.athlete_id);
      if (match) {
        highest = Math.max(highest, Number.parseInt(match[1], 10));
      }
    }

    let candidate = '';
    let next = highest + 1;
    do {
      candidate = `ath-${String(next).padStart(3, '0')}`;
      next += 1;
    } while (rosterById.has(candidate));

    return candidate;
  }, [roster, rosterAvailable, rosterById]);

  /**
   * What the record ID field actually shows: the admin's own text once they
   * have typed any, and the suggestion until then.
   *
   * Derived rather than pushed into state by an effect. Writing the suggestion
   * into athleteId would mean a render that immediately triggers another one,
   * and it would also make "the admin chose this" and "we guessed this"
   * indistinguishable afterwards -- which is the thing the lock below and the
   * submit path both need to tell apart.
   *
   * Suppressed once the roster record is written: from that point the id is
   * the key to a row that exists, and changing it would orphan that row behind
   * a second one.
   */
  const effectiveAthleteId =
    athleteMode === 'new' && !athleteIdEdited && !rosterCreatedFor && suggestedAthleteId
      ? suggestedAthleteId
      : athleteId;

  const trimmedAthleteId = effectiveAthleteId.trim();

  /**
   * Is this child already on the roster under a different record ID?
   *
   * THIS SHIPS WITH THE AUTOFILL ABOVE, NOT AFTER IT. Typing an ID by hand and
   * finding it taken used to be the one moment an admin stopped and asked
   * "wait -- is this the same kid?". Filling the ID in removes that moment, so
   * something has to replace it, or the change makes the real hazard more
   * likely rather than less.
   *
   * The hazard is NOT a duplicate ID -- the create route is create-only and
   * the primary key refuses one, and the form already names the clash. It is
   * the same child entered twice under two IDs: two sets of sessions, goals
   * and reviews that can never be added together, and no error anywhere,
   * because as far as the database is concerned they are two children.
   *
   * Name AND date of birth, never name alone: two Alex Johnsons in one gym is
   * ordinary, and a warning that cries wolf on it gets clicked through within
   * a week.
   */
  const normalizedName = athleteFullName.trim().replace(/\s+/g, ' ').toLowerCase();

  const duplicateChild = useMemo(() => {
    if (athleteMode !== 'new' || !normalizedName || !athleteDob.trim()) {
      return undefined;
    }
    return roster.find(
      (athlete) =>
        athlete.athlete_id !== trimmedAthleteId
        && athlete.full_name.trim().replace(/\s+/g, ' ').toLowerCase() === normalizedName
        && athlete.dob === athleteDob.trim(),
    );
  }, [athleteMode, normalizedName, athleteDob, roster, trimmedAthleteId]);

  // Same name, different birthday. Genuinely common and genuinely fine, so it
  // is a remark and not a gate -- but it is worth saying, because it is also
  // what a mistyped birthday on a real duplicate looks like.
  const sameNameDifferentDob = useMemo(() => {
    if (athleteMode !== 'new' || !normalizedName || duplicateChild) {
      return undefined;
    }
    return roster.find(
      (athlete) =>
        athlete.athlete_id !== trimmedAthleteId
        && athlete.full_name.trim().replace(/\s+/g, ' ').toLowerCase() === normalizedName,
    );
  }, [athleteMode, normalizedName, duplicateChild, roster, trimmedAthleteId]);

  // A hand-typed athlete_id that lands on someone already in the roster is the
  // dangerous case: the create route now refuses it, but catching it here
  // names the athlete they would have hit and points at the mode that
  // actually does what they want.
  const collidingAthlete =
    athleteMode === 'new' && trimmedAthleteId && rosterCreatedFor !== trimmedAthleteId
      ? rosterById.get(trimmedAthleteId)
      : undefined;

  // Once the roster half of the create has been written, the retry only
  // resubmits the sign-in half -- createAthleteRecord is skipped. Editing
  // these fields afterwards would therefore look like a correction and change
  // nothing, and editing the record ID would create a second row and orphan
  // the first, so the whole details block is locked until the id changes.
  const athleteDetailsLocked = Boolean(rosterCreatedFor) && rosterCreatedFor === trimmedAthleteId;

  // Every roster field is `not null` server-side and a blank one comes back as
  // a generic 500, so the submit button stays down until they are all filled.
  const newAthleteReady = Boolean(
    athleteFullName.trim()
    && athleteDob.trim()
    && athleteWeightClass.trim()
    && athleteGymStatus
    && athleteEmergencyContact.trim()
    && athleteCoachId,
  );

  const canSubmitAthlete =
    Boolean(athleteAccountId.trim() && trimmedAthleteId)
    && (athleteMode === 'new'
      ? newAthleteReady && !collidingAthlete && (!duplicateChild || duplicateAcknowledged)
      : true);

  /**
   * Why the submit button is down, or null when it is live.
   *
   * Keeping the button disabled until every field is filled is right -- a
   * blank roster field comes back from the server as an opaque 500, so
   * refusing to send it beats sending it. What was missing was the sentence
   * saying WHICH field, and the omission is worse than it looks: a disabled
   * button also suppresses the browser's own "Please fill out this field"
   * bubble that the `required` attributes would otherwise raise. So the form
   * had two ways to explain itself and used neither -- the button simply sat
   * there greyed out.
   *
   * The list mirrors newAthleteReady above; the two must not drift.
   */
  const athleteSubmitBlockedReason = useMemo(() => {
    // Both of these have their own, more specific warning rendered against
    // the fields they are about. Repeating them here would say less, twice.
    if (collidingAthlete || (duplicateChild && !duplicateAcknowledged)) {
      return null;
    }

    const missing: string[] = [];

    if (athleteMode === 'new') {
      if (!trimmedAthleteId) missing.push('athlete record ID');
      if (!athleteFullName.trim()) missing.push('full name');
      if (!athleteDob.trim()) missing.push('date of birth');
      if (!athleteWeightClass.trim()) missing.push('weight class');
      if (!athleteGymStatus) missing.push('gym status');
      if (!athleteEmergencyContact.trim()) missing.push('emergency contact');
      if (!athleteCoachId) {
        // Naming the cure matters more here than naming the field: an admin
        // whose gym has no coaches yet cannot fix this on this form at all,
        // and would otherwise keep looking for a control that is empty by
        // necessity.
        missing.push(
          coachOptions.length === 0
            ? 'a coach - your gym has none yet, so add one on the "Add Coach, Staff Or Guardian" tab first'
            : 'coach',
        );
      }
    } else if (!trimmedAthleteId) {
      missing.push('the athlete this login is for');
    }

    if (!athleteAccountId.trim()) missing.push('sign-in ID');

    return missing.length === 0 ? null : `Still needed: ${missing.join(', ')}.`;
  }, [
    athleteMode,
    collidingAthlete,
    duplicateChild,
    duplicateAcknowledged,
    trimmedAthleteId,
    athleteFullName,
    athleteDob,
    athleteWeightClass,
    athleteGymStatus,
    athleteEmergencyContact,
    athleteCoachId,
    athleteAccountId,
    coachOptions.length,
  ]);

  // A parent invite is not submittable until the athlete it links to has been
  // chosen. The server refuses the role without one, and an account created
  // half way is the exact failure this form exists to prevent.
  const inviteReady =
    Boolean(inviteEmail.trim())
    && (inviteRole !== 'parent'
      || Boolean(
        !parentInviteBlockedReason && guardianFullName.trim() && guardianAthleteId && guardianRelationship,
      ));

  async function inviteStaff(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);

    const email = inviteEmail.trim();
    const linkedAthleteName = guardianAthleteId
      ? rosterById.get(guardianAthleteId)?.full_name || guardianAthleteId
      : '';

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          login_email: email,
          role: inviteRole,
          ...(inviteRole === 'parent'
            ? {
                guardian: {
                  athlete_id: guardianAthleteId,
                  full_name: guardianFullName.trim(),
                  relationship_to_athlete: guardianRelationship,
                },
              }
            : {}),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not add that person');
      }

      // Naming the child back is the check on the one mistake this form can
      // make that nobody else would catch: linking a guardian to the wrong
      // athlete.
      setNotice(
        inviteRole === 'parent'
          ? `${email} is now a guardian of ${linkedAthleteName} and will see that athlete and no one else. They must also be a guest in the PPBF Microsoft tenant before they can sign in.`
          : `${email} is now a ${roleLabel(inviteRole)} in your gym. They must also be a guest in the PPBF Microsoft tenant before they can sign in.`,
      );
      setInviteEmail('');
      setGuardianFullName('');
      setGuardianAthleteId('');
      await load();
      setTab('people');
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Could not add that person');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Detaches a guardian from one athlete. The server refuses to remove the
   * last link an account holds, so this cannot be the step that leaves a
   * family with an account that signs in and shows them nothing.
   */
  async function removeGuardianLink(accountId: string, athleteId: string, athleteName: string) {
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/staff`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ account_id: accountId, athlete_id: athleteId }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not remove that guardian link');
      }

      setPendingUnlink(null);
      setNotice(`${accountId} can no longer see ${athleteName}.`);
      await load();
    } catch (unlinkError) {
      setError(unlinkError instanceof Error ? unlinkError.message : 'Could not remove that guardian link');
    } finally {
      setBusy(false);
    }
  }

  function resetAthleteForm() {
    setAthleteAccountId('');
    setAthleteId('');
    // Hand the field back to the suggestion, so adding a second athlete in a
    // row offers the next id rather than an empty box. load() refreshes the
    // roster first, so the one it offers already accounts for the athlete
    // just created.
    setAthleteIdEdited(false);
    setDuplicateAcknowledged(false);
    setAthleteFullName('');
    setAthleteDob('');
    setAthleteWeightClass('');
    setAthleteGymStatus(GYM_STATUS_OPTIONS[0].value);
    setAthleteEmergencyContact('');
    setAthleteCoachId('');
    setRosterCreatedFor('');
  }

  /**
   * Writes the pilot.athletes row. The validator rejects the payload outright
   * if any key is absent or extra, so all ten fields are sent every time and
   * none of them may be blank -- the form enforces that client-side because a
   * blank one comes back as an opaque 500, not a field-level complaint.
   */
  async function createAthleteRecord(recordId: string) {
    const timestamp = new Date().toISOString();

    const response = await fetch(`${apiBase()}/api/pilot/athletes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        athlete_id: recordId,
        full_name: athleteFullName.trim(),
        dob: athleteDob.trim(),
        weight_class: athleteWeightClass.trim(),
        gym_status: athleteGymStatus,
        emergency_contact: athleteEmergencyContact.trim(),
        active_flag: true,
        coach_id: athleteCoachId,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };

    if (!response.ok || !payload.ok) {
      // 409 here is the opposite complaint to the 404 the account step can
      // raise, and the fix is the opposite too, so it must not read as the
      // same failure. Nothing was written -- the id belongs to someone else.
      if (response.status === 409) {
        throw new Error(
          `Athlete record "${recordId}" already exists in your gym. Nothing was changed. If that is this same athlete and they only need a login, switch to “Already on the roster”; otherwise give this athlete a different record ID.`,
        );
      }
      throw new Error(payload.error || 'Could not create that athlete record');
    }
  }

  async function addAthlete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);

    const accountId = athleteAccountId.trim();
    const recordId = trimmedAthleteId;

    // Pin the suggestion into state before anything is written. Everything
    // after this point -- the half-done lock, the retry that skips the roster
    // write, the collision check -- compares against the id that was actually
    // submitted, and a value that is still being derived would evaporate the
    // moment the roster reloads and the next free id moves on.
    if (!athleteIdEdited) {
      setAthleteId(recordId);
      setAthleteIdEdited(true);
    }

    // Tracked locally as well as in state because the catch below runs before
    // React has applied setRosterCreatedFor, and it needs to know whether the
    // roster half of the work survived the failure.
    let recordExists = athleteMode === 'existing' || rosterCreatedFor === recordId;

    try {
      // Step one, and only for a genuinely new athlete: the roster record the
      // account has to point at. Skipped on a retry that already got this far.
      if (!recordExists) {
        await createAthleteRecord(recordId);
        setRosterCreatedFor(recordId);
        recordExists = true;
      }

      const createResponse = await fetch(`${apiBase()}/api/pilot/admin/athlete-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ account_id: accountId, athlete_id: recordId }),
      });

      const createPayload = (await createResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!createResponse.ok || !createPayload.ok) {
        // The original bug's error message, reached now only when linking to a
        // record that is supposed to already exist. Say which id was missing
        // and which mode creates it, rather than repeating the bare server text.
        if (createResponse.status === 404) {
          throw new Error(
            `No athlete record "${recordId}" in your gym, so there is nothing to attach a login to. Switch to “New to the gym” to create the record and the sign-in together.`,
          );
        }
        throw new Error(createPayload.error || 'Could not create that athlete account');
      }

      // The account now exists server-side regardless of what happens next,
      // so the form must not stay primed to resubmit the same account_id/
      // athlete_id -- that would just hit "Account already exists" on retry.
      const createdAccountId = accountId;
      resetAthleteForm();

      // No code to mint and nothing further to go wrong: the account is live
      // on the shared starting PIN, and the athlete is forced to replace it
      // the first time they sign in.
      setCreatedAthlete({ accountId: createdAccountId });

      await load();
      setTab('people');
    } catch (addError) {
      const message = addError instanceof Error ? addError.message : 'Could not add that athlete';

      // A roster record may have been written before this failure, so reload
      // before reporting it -- otherwise “Already on the roster” goes on
      // insisting the gym has no athlete records while the banner below says
      // one was just saved. load() clears the error first, hence setError
      // after it.
      if (athleteMode === 'new' && recordExists) {
        await load();
      }

      // Half-done is the confusing state to land in, so say so outright: the
      // roster record is saved and resubmitting will not duplicate it, only
      // the sign-in still needs fixing.
      setError(
        athleteMode === 'new' && recordExists
          ? `${message} The roster record for “${athleteFullName.trim() || recordId}” was saved and its details are now locked — correct the sign-in ID and submit again; it will not be created twice.`
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Put an existing athlete back on the starting PIN. This is the recovery
   * path for "I forgot my PIN" -- it replaces issuing a fresh activation
   * code, and lands the account in exactly the state a new one starts in, so
   * the athlete is forced to choose a new PIN on their next sign-in.
   */
  async function handleResetToStartingPin(accountId: string) {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/accounts/pin-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ account_id: accountId, mode: 'reset', pin: DEFAULT_FIRST_LOGIN_PIN }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not reset that PIN');
      }
      setNotice(
        `${accountId} is back on the starting PIN ${DEFAULT_FIRST_LOGIN_PIN}. They will have to choose a new one when they sign in.`,
      );
      await load();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Could not reset that PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-6 shadow-[var(--shadow-md)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--brass-800)]">People</p>
              <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Manage Your Gym</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Add coaches and staff, and create athlete sign-ins.
                {organizationId && (
                  <>
                    {' '}Gym: <span className="font-mono font-semibold text-[var(--black)]">{organizationId}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Board members are appointed to a seat, not added to the gym
                  roster, so the two surfaces are separate. Only an
                  organization admin reaches this markup -- a platform owner is
                  shown WrongRoleNotice before the console renders. */}
              <Link
                href="/admin/board-seats"
                className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
              >
                Board Seats
              </Link>
              <Link
                href="/admin"
                className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
              >
                Admin Home
              </Link>
            </div>
          </div>
        </header>

        {/* What to tell the athlete. Unlike the activation code this replaced,
            nothing here is secret or one-shot -- the starting PIN is the same
            for everyone and can be re-read at any time, so this panel is a
            convenience rather than a last chance. */}
        {createdAthlete && (
          <section className="rounded-2xl border-2 border-[color:var(--brass-600)] bg-white p-5 shadow-[var(--shadow-md)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">{createdAthlete.accountId} can sign in now</h2>
                <p className="mt-1 text-sm text-[var(--gray-dark)]">
                  Tell them these two things. They will have to choose their own PIN the first time they sign in, and
                  you will never see what they pick.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCreatedAthlete(null)}
                className="min-h-[44px] rounded-full border border-[rgba(0,0,0,0.14)] px-4 text-xs font-bold uppercase tracking-[0.1em]"
              >
                Done
              </button>
            </div>

            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-4 py-3">
                <dt className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--gray-dark)]">Sign-in ID</dt>
                <dd className="mt-1 font-mono text-xl font-black">{createdAthlete.accountId}</dd>
              </div>
              <div className="rounded-xl border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-4 py-3">
                <dt className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--gray-dark)]">Starting PIN</dt>
                <dd className="mt-1 font-mono text-xl font-black tracking-[0.2em]">{DEFAULT_FIRST_LOGIN_PIN}</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs leading-5 text-[var(--gray-dark)]">
              The starting PIN is the same for every new athlete, so it is not a secret. It cannot be used to see
              anything — the only screen it opens is the one that asks them to replace it.
            </p>
          </section>
        )}

        {error && (
          <p role="alert" className="rounded-xl border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] px-4 py-3 text-sm font-semibold text-[var(--safety-locked)]">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-xl border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.08)] px-4 py-3 text-sm font-semibold text-[var(--cleared-deep)]">
            {notice}
          </p>
        )}

        <nav className="flex flex-wrap gap-2 rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white p-2">
          {([
            ['people', `Everyone${members.length ? ` (${members.length})` : ''}`],
            ['invite-staff', 'Add Coach, Staff Or Guardian'],
            ['add-athlete', 'Add Athlete'],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`min-h-[44px] flex-1 rounded-xl px-4 text-sm font-bold uppercase tracking-[0.1em] transition ${
                tab === key
                  ? 'bg-[var(--brass-800)] text-white'
                  : 'bg-transparent text-[var(--gray-dark)] hover:bg-[var(--canvas-tan)]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'people' && (
          <section className="space-y-4">
            {/* Accounts provisioned before a guardian link was mandatory. They
                sign in and see nothing, and nothing else in the product says
                so. */}
            {strandedGuardians.length > 0 && (
              <div className="rounded-2xl border-2 border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] p-4">
                <p className="text-sm font-bold text-[var(--safety-locked)]">
                  {strandedGuardians.length} guardian{strandedGuardians.length === 1 ? '' : 's'} linked to no athlete
                </p>
                <p className="mt-1 text-sm text-[var(--gray-dark)]">
                  {strandedGuardians.length === 1 ? 'This account signs in' : 'These accounts sign in'} successfully and
                  then {strandedGuardians.length === 1 ? 'shows' : 'show'} no children at all. Add the same email
                  address again on “Add Coach, Staff Or Guardian”, choose Parent / Guardian, and name their athlete.
                </p>
                <ul className="mt-2 space-y-1">
                  {strandedGuardians.map((guardian) => (
                    <li key={guardian.account_id} className="truncate font-mono text-xs font-semibold">
                      {guardian.login_email || guardian.account_id}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {members.some((member) => member.role === 'parent') && !guardianLinksAvailable && (
              <p
                role="status"
                className="rounded-2xl border border-[rgba(0,0,0,0.2)] bg-white px-4 py-3 text-sm text-[var(--gray-dark)]"
              >
                Guardian links could not be read, so this list cannot say which children each Parent / Guardian sees.
                Reload the page to try again.
              </p>
            )}

            {pendingAthletes.length > 0 && (
              <div className="rounded-2xl border border-[color-mix(in_srgb,var(--accent)_35%,white)] bg-[color-mix(in_srgb,var(--accent)_4%,white)] p-4">
                <p className="text-sm font-bold">
                  {pendingAthletes.length} athlete{pendingAthletes.length === 1 ? '' : 's'} cannot sign in yet
                </p>
                <p className="mt-1 text-sm text-[var(--gray-dark)]">
                  Give them their sign-in ID and the starting PIN {DEFAULT_FIRST_LOGIN_PIN}. If they have forgotten
                  where they are, “Reset to starting PIN” on their row puts them back to it.
                </p>
              </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white shadow-[var(--shadow-sm)]">
              {loading ? (
                <p className="p-6 text-sm text-[var(--gray-dark)]">Loading your gym roster...</p>
              ) : members.length === 0 ? (
                <div className="space-y-3 p-6 text-center">
                  <p className="text-sm font-semibold">Nobody here yet.</p>
                  <p className="text-sm text-[var(--gray-dark)]">
                    Start by adding a coach, or create your first athlete account.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[rgba(0,0,0,0.08)]">
                  {members.map((member) => {
                    const isGuardian = member.role === 'parent';
                    const memberLinks = guardianLinksByAccount.get(member.account_id) || [];
                    const linkCount = !isGuardian ? null : guardianLinksAvailable ? memberLinks.length : null;
                    const status = signInStatus(member, linkCount);
                    const isPinAthlete = member.auth_provider === 'ppbf_local' && member.role === 'athlete';

                    return (
                      <li key={member.account_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">{member.login_email || member.account_id}</p>
                          <p className="mt-1 text-xs text-[var(--gray-dark)]">
                            {roleLabel(member.role)}
                            {member.athlete_id && <> · Athlete ID {member.athlete_id}</>}
                          </p>
                          <p
                            className={`mt-1 text-xs font-bold uppercase tracking-[0.1em] ${
                              status.tone === 'ok'
                                ? 'text-[var(--cleared-deep)]'
                                : status.tone === 'pending'
                                  ? 'text-[color:var(--brass-800)]'
                                  : 'text-[var(--gray-dark)]'
                            }`}
                          >
                            {status.label}
                          </p>

                          {/* Exactly which children this adult can open. A
                              guardian row without it says nothing about the
                              only thing the account does. */}
                          {isGuardian && guardianLinksAvailable && memberLinks.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {memberLinks.map((link) => {
                                const confirming =
                                  pendingUnlink?.accountId === member.account_id
                                  && pendingUnlink?.athleteId === link.athlete_id;

                                return (
                                  <li
                                    key={link.athlete_id}
                                    className="flex flex-wrap items-center gap-2 text-xs text-[var(--gray-dark)]"
                                  >
                                    <span>
                                      Sees <span className="font-semibold text-[var(--black)]">{link.athlete_full_name}</span>{' '}
                                      ({link.relationship_to_athlete})
                                    </span>
                                    {confirming ? (
                                      <>
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() =>
                                            void removeGuardianLink(
                                              member.account_id,
                                              link.athlete_id,
                                              link.athlete_full_name,
                                            )
                                          }
                                          className="min-h-[44px] rounded-full border-2 border-[var(--accent)] bg-[var(--accent-strong)] px-3 text-[11px] font-black uppercase tracking-[0.08em] text-[var(--accent-ink)] disabled:opacity-50"
                                        >
                                          Confirm Remove
                                        </button>
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => setPendingUnlink(null)}
                                          className="min-h-[44px] rounded-full border border-[rgba(0,0,0,0.2)] px-3 text-[11px] font-bold uppercase tracking-[0.08em] disabled:opacity-50"
                                        >
                                          Keep
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                          setPendingUnlink({
                                            accountId: member.account_id,
                                            athleteId: link.athlete_id,
                                          })
                                        }
                                        className="min-h-[44px] rounded-full border border-[rgba(0,0,0,0.2)] px-3 text-[11px] font-bold uppercase tracking-[0.08em] disabled:opacity-50"
                                      >
                                        Remove
                                      </button>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}

                          {isGuardian && guardianLinksAvailable && memberLinks.length === 0 && (
                            <p className="mt-2 text-xs leading-5 text-[color:var(--brass-800)]">
                              This guardian resolves no children, so they sign in to an empty page. Invite the same
                              email address again on “Add Coach, Staff Or Guardian” and name the athlete to repair it.
                            </p>
                          )}
                        </div>

                        {isPinAthlete && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleResetToStartingPin(member.account_id)}
                            className="min-h-[44px] shrink-0 rounded-xl border-2 border-[var(--accent)] bg-white px-4 text-xs font-black uppercase tracking-[0.1em] text-[var(--accent-quiet)] transition hover:bg-[color-mix(in_srgb,var(--accent)_6%,white)] disabled:opacity-50"
                          >
                            Reset To Starting PIN
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        )}

        {tab === 'invite-staff' && (
          <form onSubmit={inviteStaff} className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
            <div>
              <h2 className="text-lg font-black">Add a coach, staff member, or guardian</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Adults sign in with Microsoft, not a PIN. Enter the Microsoft email address they will use.
              </p>
            </div>

            <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_25%,white)] bg-[color-mix(in_srgb,var(--accent)_4%,white)] p-4">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--accent-quiet)]">Two steps, not one</p>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                This form gives them a role in PPBF. If they are outside your Microsoft organization, someone also has to
                invite them as a guest in Entra ID — until that is done, their sign-in will be rejected.
              </p>
            </div>

            <div>
              <label htmlFor="invite-email" className="block text-sm font-semibold">
                Microsoft email address
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="coach@example.com"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
              />
            </div>

            <fieldset>
              <legend className="text-sm font-semibold">Role</legend>
              <div className="mt-2 space-y-2">
                {STAFF_ROLES.map((option) => {
                  const blockedReason = option.value === 'parent' ? parentInviteBlockedReason : null;

                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-3 rounded-xl border p-3 transition ${
                        blockedReason
                          ? 'cursor-not-allowed border-[rgba(0,0,0,0.12)] opacity-70'
                          : inviteRole === option.value
                            ? 'cursor-pointer border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_5%,white)]'
                            : 'cursor-pointer border-[rgba(0,0,0,0.12)] hover:border-[rgba(0,0,0,0.3)]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="invite-role"
                        value={option.value}
                        checked={inviteRole === option.value}
                        disabled={Boolean(blockedReason)}
                        onChange={() => setInviteRole(option.value)}
                        className="mt-1 accent-[var(--accent-quiet)]"
                      />
                      <span>
                        <span className="block text-sm font-semibold">{option.label}</span>
                        <span className="mt-0.5 block text-xs text-[var(--gray-dark)]">{option.blurb}</span>
                        {blockedReason && (
                          <span className="mt-1 block text-xs font-semibold text-[var(--safety-locked)]">
                            {blockedReason}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-[var(--gray-dark)]">
                Adding another gym admin is a platform-owner action — ask PPBF to do it.
              </p>
            </fieldset>

            {/* A parent account reads the gym through this link and nothing
                else, so it is captured with the invite rather than left for a
                screen that does not exist. */}
            {inviteRole === 'parent' && !parentInviteBlockedReason && (
              <fieldset className="space-y-4 rounded-xl border border-[rgba(0,0,0,0.12)] p-4">
                <legend className="px-1 text-xs font-bold uppercase tracking-[0.1em] text-[var(--accent-quiet)]">
                  Which child
                </legend>
                <p className="text-sm leading-6 text-[var(--gray-dark)]">
                  A guardian sees only the athletes named here, and this is the only screen that links them. To give a
                  guardian a second child, add the same email address again and choose the other athlete.
                </p>

                <div>
                  <label htmlFor="guardian-full-name" className="block text-sm font-semibold">
                    Guardian&apos;s full name
                  </label>
                  <input
                    id="guardian-full-name"
                    type="text"
                    required
                    value={guardianFullName}
                    onChange={(event) => setGuardianFullName(event.target.value)}
                    placeholder="Dana Johnson"
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                </div>

                <div>
                  <label htmlFor="guardian-athlete" className="block text-sm font-semibold">
                    Athlete
                  </label>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    Check this carefully — it decides whose records this adult can open.
                  </p>
                  <select
                    id="guardian-athlete"
                    required
                    value={guardianAthleteId}
                    onChange={(event) => setGuardianAthleteId(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  >
                    <option value="">Choose an athlete...</option>
                    {roster.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>
                        {athlete.full_name} ({athlete.athlete_id})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="guardian-relationship" className="block text-sm font-semibold">
                    Relationship to the athlete
                  </label>
                  <select
                    id="guardian-relationship"
                    required
                    value={guardianRelationship}
                    onChange={(event) => setGuardianRelationship(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  >
                    {GUARDIAN_RELATIONSHIPS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>
            )}

            <button
              type="submit"
              disabled={busy || !inviteReady}
              className="min-h-[50px] w-full rounded-xl border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding...' : 'Add To My Gym'}
            </button>
          </form>
        )}

        {tab === 'add-athlete' && (
          <form onSubmit={addAthlete} className="space-y-5 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
            <div>
              <h2 className="text-lg font-black">Add an athlete</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                This puts the athlete in your gym and gives you a sign-in ID to hand them, along with the starting PIN
                every new athlete gets. They have to choose their own PIN the first time they sign in — you never see it.
              </p>
            </div>

            <fieldset>
              <legend className="text-sm font-semibold">Where is this athlete now?</legend>
              <div className="mt-2 space-y-2">
                {ATHLETE_MODES.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                      athleteMode === option.value
                        ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_5%,white)]'
                        : 'border-[rgba(0,0,0,0.12)] hover:border-[rgba(0,0,0,0.3)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="athlete-mode"
                      value={option.value}
                      checked={athleteMode === option.value}
                      onChange={() => {
                        setAthleteMode(option.value);
                        // The two modes mean different things by "athlete id":
                        // one is being invented, the other is being chosen off
                        // a list. Carrying a value across would submit an id
                        // the admin never picked in this mode.
                        setAthleteId('');
                        setDuplicateAcknowledged(false);
                        // Clearing the field is not enough on its own: without
                        // this, switching to "new" would leave the suggestion
                        // suppressed because an earlier edit had claimed the
                        // field, and the admin would get a blank box back.
                        setAthleteIdEdited(false);
                      }}
                      className="mt-1 accent-[var(--brass-600)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-[var(--gray-dark)]">{option.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {athleteMode === 'new' ? (
              // Disabled as a block once the record is written: the retry
              // sends only the sign-in half, so an edit here would silently
              // change nothing, and an edited record ID would leave the
              // already-written row orphaned behind a second one.
              <fieldset
                disabled={athleteDetailsLocked}
                className="space-y-4 rounded-xl border border-[rgba(0,0,0,0.12)] p-4 disabled:opacity-70"
              >
                <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--accent-quiet)]">Athlete Details</p>

                <div>
                  <label htmlFor="athlete-id" className="block text-sm font-semibold">
                    Athlete record ID
                  </label>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    Permanent id for their record in your roster — every session, goal, and review hangs off it.{' '}
                    {suggestedAthleteId
                      ? 'Filled in with the next free one; change it if your gym numbers athletes its own way.'
                      : 'Short and unique, like ath-001.'}
                  </p>
                  <input
                    id="athlete-id"
                    type="text"
                    required
                    value={effectiveAthleteId}
                    onChange={(event) => {
                      setAthleteIdEdited(true);
                      setAthleteId(event.target.value.trim());
                    }}
                    placeholder="ath-001"
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                  {collidingAthlete && (
                    <p className="mt-2 rounded-xl border border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] px-3 py-2 text-xs font-semibold text-[var(--safety-locked)]">
                      {collidingAthlete.full_name} already holds record ID {collidingAthlete.athlete_id}. Pick a
                      different ID — or, if that is this same athlete, switch to “Already on the roster”.
                    </p>
                  )}
                  {athleteDetailsLocked && (
                    <p className="mt-2 text-xs font-semibold text-[var(--cleared-deep)]">
                      Roster record saved, so these details are locked — they are not resent when you submit again.
                      Finish by giving them a sign-in ID below. To start a different athlete instead, switch modes
                      above and back.
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="athlete-full-name" className="block text-sm font-semibold">
                    Full name
                  </label>
                  <input
                    id="athlete-full-name"
                    type="text"
                    required
                    value={athleteFullName}
                    onChange={(event) => {
                      // Editing the identity re-opens the question the tick
                      // answered. Carrying it across would let a tick read for
                      // one child wave a different one through.
                      setDuplicateAcknowledged(false);
                      setAthleteFullName(event.target.value);
                    }}
                    placeholder="Alex Johnson"
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="athlete-dob" className="block text-sm font-semibold">
                      Date of birth
                    </label>
                    <input
                      id="athlete-dob"
                      type="date"
                      required
                      value={athleteDob}
                      onChange={(event) => {
                        setDuplicateAcknowledged(false);
                        setAthleteDob(event.target.value);
                      }}
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                    />
                  </div>

                  <div>
                    <label htmlFor="athlete-weight-class" className="block text-sm font-semibold">
                      Weight class
                    </label>
                    <input
                      id="athlete-weight-class"
                      type="text"
                      required
                      value={athleteWeightClass}
                      onChange={(event) => setAthleteWeightClass(event.target.value)}
                      placeholder="middleweight"
                      className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                    />
                  </div>
                </div>

                {duplicateChild && (
                  // Blocks the submit until it is answered. The database will
                  // happily accept this -- two ids, two children, no error
                  // anywhere -- so a person is the only check there is.
                  <div className="rounded-xl border-2 border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] p-3">
                    <p className="text-sm font-black uppercase tracking-[0.08em] text-[var(--safety-locked)]">
                      This may already be the same child
                    </p>
                    <p className="mt-2 text-xs leading-5">
                      <strong>{duplicateChild.full_name}</strong>, born {duplicateChild.dob}, is already on your
                      roster as <code>{duplicateChild.athlete_id}</code>. Adding them again makes a second record:
                      their sessions, goals and reviews would be split across the two and could never be added back
                      together.
                    </p>
                    <p className="mt-2 text-xs leading-5">
                      If this is that child and they only need a sign-in, switch to &ldquo;Already on the roster&rdquo;
                      above.
                    </p>
                    <label className="mt-3 flex items-start gap-2 text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={duplicateAcknowledged}
                        onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
                        className="mt-0.5 h-4 w-4"
                      />
                      <span>
                        I have checked, and this is a different child who happens to share a name and a birthday.
                      </span>
                    </label>
                  </div>
                )}

                {sameNameDifferentDob && (
                  // Not a gate. Two Alex Johnsons in one gym is ordinary, and
                  // a warning that cries wolf on it gets clicked through
                  // within a week. But a mistyped birthday on a genuine
                  // duplicate looks exactly like this, so it is worth saying.
                  <p className="rounded-xl border border-[rgba(0,0,0,0.16)] bg-[color-mix(in_srgb,var(--accent)_4%,white)] px-3 py-2 text-xs leading-5">
                    {sameNameDifferentDob.full_name} is already on your roster as{' '}
                    <code>{sameNameDifferentDob.athlete_id}</code>, with a different date of birth. Fine if they are
                    two different people &mdash; worth a second look at the birthday if they are not.
                  </p>
                )}

                <div>
                  <label htmlFor="athlete-gym-status" className="block text-sm font-semibold">
                    Status in the gym
                  </label>
                  <select
                    id="athlete-gym-status"
                    required
                    value={athleteGymStatus}
                    onChange={(event) => setAthleteGymStatus(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  >
                    {GYM_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="athlete-emergency-contact" className="block text-sm font-semibold">
                    Emergency contact
                  </label>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    Who to call, and the number. Required — an athlete cannot train without one on file.
                  </p>
                  <input
                    id="athlete-emergency-contact"
                    type="text"
                    required
                    value={athleteEmergencyContact}
                    onChange={(event) => setAthleteEmergencyContact(event.target.value)}
                    placeholder="Dana Johnson (mother) 555-0101"
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  />
                </div>

                <div>
                  <label htmlFor="athlete-coach" className="block text-sm font-semibold">
                    Coach
                  </label>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    {coachOptions.length > 0
                      ? 'A coach only sees the athletes assigned to them. Every athlete record has to name one, so pick whoever will be working with them.'
                      : 'No coaches in your gym yet, and an athlete record has to name one — add a coach on the “Add Coach, Staff Or Guardian” tab, then come back here.'}
                  </p>
                  <select
                    id="athlete-coach"
                    required
                    value={athleteCoachId}
                    onChange={(event) => setAthleteCoachId(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  >
                    <option value="">Choose a coach...</option>
                    {coachOptions.map((coach) => (
                      <option key={coach.account_id} value={coach.account_id}>
                        {coach.login_email || coach.account_id}
                      </option>
                    ))}
                  </select>
                </div>
              </fieldset>
            ) : rosterAvailable ? (
              unlinkedAthletes.length === 0 ? (
                <div className="rounded-xl border border-[color-mix(in_srgb,var(--accent)_25%,white)] bg-[color-mix(in_srgb,var(--accent)_4%,white)] p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--accent-quiet)]">
                    Nobody is waiting
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                    {roster.length === 0
                      ? 'There are no athlete records in your gym yet, so there is nothing to attach a login to. Choose “New to the gym” above.'
                      : 'Every athlete on your roster already has a sign-in. Choose “New to the gym” above to add someone else.'}
                  </p>
                </div>
              ) : (
                <div>
                  <label htmlFor="athlete-id-picker" className="block text-sm font-semibold">
                    Which athlete
                  </label>
                  <p className="mt-1 text-xs text-[var(--gray-dark)]">
                    Only athletes with no sign-in yet are listed — {unlinkedAthletes.length} of {roster.length} on your
                    roster.
                  </p>
                  <select
                    id="athlete-id-picker"
                    required
                    value={athleteId}
                    onChange={(event) => setAthleteId(event.target.value)}
                    className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] bg-white px-3 text-sm focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                  >
                    <option value="">Choose an athlete...</option>
                    {unlinkedAthletes.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>
                        {athlete.full_name} ({athlete.athlete_id})
                      </option>
                    ))}
                  </select>
                </div>
              )
            ) : (
              // Fallback for when the roster directory could not be read. The
              // link still works by id, so keep the tab usable -- but say
              // plainly that this mode will not create anything, which is
              // exactly the confusion the typed-id form used to cause.
              <div>
                <label htmlFor="athlete-id" className="block text-sm font-semibold">
                  Athlete record ID
                </label>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  Your roster could not be loaded, so type the id. The record must already exist — this mode only
                  attaches a login to it. If the athlete is new, choose “New to the gym” above instead.
                </p>
                <input
                  id="athlete-id"
                  type="text"
                  required
                  value={athleteId}
                  onChange={(event) => setAthleteId(event.target.value.trim())}
                  placeholder="ath-001"
                  className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
                />
              </div>
            )}

            <div>
              <label htmlFor="athlete-account-id" className="block text-sm font-semibold">
                Sign-in ID
              </label>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">
                What the athlete types to sign in. Keep it simple and unique, like <code>jsmith</code>.
              </p>
              <input
                id="athlete-account-id"
                type="text"
                required
                value={athleteAccountId}
                onChange={(event) => setAthleteAccountId(event.target.value.trim())}
                placeholder="jsmith"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:shadow-[var(--focus)]"
              />
            </div>

            {!busy && athleteSubmitBlockedReason && (
              <p
                role="status"
                className="rounded-xl border border-[rgba(0,0,0,0.16)] bg-[color-mix(in_srgb,var(--accent)_4%,white)] px-3 py-2 text-xs font-semibold text-[var(--gray-dark)]"
              >
                {athleteSubmitBlockedReason}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !canSubmitAthlete}
              className="min-h-[50px] w-full rounded-xl border-2 border-[color:var(--brass-600)] bg-[var(--brass-800)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy
                ? 'Creating...'
                : athleteMode === 'new'
                  ? 'Add Athlete & Get Code'
                  : 'Create Sign-In & Get Code'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function PeopleConsoleRoleSwitch() {
  const session = usePilotSession();

  if (session.loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <p className="text-sm text-[var(--gray-dark)]">Loading...</p>
      </main>
    );
  }

  // RoleSessionGate already proved the caller is some flavour of admin; this
  // narrows further, because 'admin' there also covers platform owners.
  if (!isOrganizationAdminSessionRole(session.role)) {
    return <WrongRoleNotice />;
  }

  return <PeopleConsoleContent />;
}

export default function PeopleConsolePage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <PeopleConsoleRoleSwitch />
    </RoleSessionGate>
  );
}
