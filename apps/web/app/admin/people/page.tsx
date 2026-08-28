'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTime } from '@/src/lib/gymTime';
// A plain constant with no server dependencies, so a client component can
// import it and the admin copy can never drift from what the server sets.
// Same reasoning: credentialPolicy is the single source of truth for which
// door each role signs in through, is dependency-free, and exists precisely
// because sign-in copy drifted from the server's rule. This page carried that
// drift: it told admins every invited adult needs the Microsoft tenant, while
// the server signs coaches, staff, volunteers and parents in by emailed link.
import { requiredCredentialFor } from '@/src/server/pilot/credentialPolicy';
import type { PilotRole } from '@/src/server/pilot/contracts';

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
  if (member.role === 'athlete' && member.auth_provider === 'ppbf_local' && !member.has_pin) {
    return { label: 'Awaiting activation', tone: 'pending' };
  }
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

  // The door is decided by ROLE (credentialPolicy), not by the stored
  // auth_provider: the magic-link issue and consume paths both key on the
  // role, so a parent row that happens to carry provider 'microsoft' still
  // signs in with the emailed link. Labelling by provider here was this
  // page's own copy drift.
  let credential: ReturnType<typeof requiredCredentialFor> | null = null;
  try {
    credential = requiredCredentialFor({ role: member.role as PilotRole });
  } catch {
    // A legacy row with a role outside the vocabulary: fall through to the
    // provider-based labels below rather than crashing the roster.
  }

  if (credential === 'magic_link') {
    if (!member.login_email) {
      return { label: 'No email on file — cannot receive a sign-in link', tone: 'blocked' };
    }
    return { label: 'Signs in with an email link', tone: 'ok' };
  }

  if (credential === 'microsoft' || member.auth_provider === 'microsoft') {
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
    <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Console</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>People is managed per gym</h1>
        <p className="t-body">
          This console belongs to a gym admin — it manages one organization&apos;s coaches, staff, and athletes. As
          platform owner you create organizations and appoint their admins, and they take it from there.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-[var(--s3)]">
          <Link href="/admin/organizations" className="btn">
            Organization Provisioning
          </Link>
          <Link href="/admin" className="btn btn--ghost">
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
  // Whether the admin has edited the record id themselves. Until they have,
  // the field shows the next free ath-NNN; afterwards it is theirs, including
  // when they have deliberately emptied it.
  const [athleteIdTouched, setAthleteIdTouched] = useState(false);
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

  // The plaintext activation code exists only in this response and is shown
  // once; only its hash is persisted server-side.
  const [createdAthlete, setCreatedAthlete] = useState<{ accountId: string; activationCode: string; expiresAt: string } | null>(null);

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
   * The next unused ath-NNN for this gym.
   *
   * Reads the highest existing number and adds one, rather than counting rows:
   * counting hands out ath-004 to a roster of four that has already used
   * ath-007, and the create route would refuse it -- safe, but it leaves the
   * admin typing numbers until one sticks. Ids that do not fit the pattern are
   * ignored rather than parsed, so a gym mixing conventions still gets a usable
   * suggestion instead of NaN.
   */
  const suggestedAthleteId = useMemo(() => {
    let highest = 0;
    for (const athlete of roster) {
      const match = /^ath-(\d+)$/i.exec(athlete.athlete_id.trim());
      if (match) {
        highest = Math.max(highest, Number.parseInt(match[1], 10));
      }
    }
    return `ath-${String(highest + 1).padStart(3, '0')}`;
  }, [roster]);

  /**
   * The id actually in the field: the suggestion until the admin touches it,
   * theirs from then on.
   *
   * Derived rather than seeded through an effect. Writing state from an effect
   * is CI-blocked here (react-hooks/set-state-in-effect) and would also fight
   * the admin: the roster arrives after first render, so a seeding effect would
   * overwrite an id they had already started typing.
   *
   * `athleteIdTouched` is what makes a DELIBERATELY EMPTY field stay empty. A
   * plain `athleteId || suggestion` fallback snaps back to the suggestion the
   * moment someone clears the box to retype it, which reads as the form
   * fighting them.
   */
  const effectiveAthleteId = athleteMode === 'existing' ? athleteId : athleteIdTouched ? athleteId : suggestedAthleteId;

  const trimmedAthleteId = effectiveAthleteId.trim();

  // A hand-typed athlete_id that lands on someone already in the roster is the
  // dangerous case: the create route now refuses it, but catching it here
  // names the athlete they would have hit and points at the mode that
  // actually does what they want.
  const collidingAthlete =
    athleteMode === 'new' && trimmedAthleteId && rosterCreatedFor !== trimmedAthleteId
      ? rosterById.get(trimmedAthleteId)
      : undefined;

  /**
   * Someone already on the roster under this name.
   *
   * THIS is the duplicate that matters, and it is not the one auto-filling an
   * id solves. Two records can never share an id -- the create route is
   * create-only and the primary key refuses a second row. What nothing
   * prevents is the same CHILD entered twice under two different ids, which
   * leaves one kid holding two sets of sessions, goals and reviews that can
   * never be added together.
   *
   * Auto-filling the id makes that MORE likely, not less: it removes the
   * moment where an admin types ath-001, finds it taken, and thinks "hold on,
   * is this the same kid?". So the suggestion and this check ship together.
   *
   * NAME ONLY, deliberately. Matching on date of birth too would be far more
   * precise, and the roster this page reads comes from the athlete PIN
   * directory -- a credential-adjacent route that was narrowed earlier
   * precisely because it returns every athlete's name. Adding every child's
   * birthday to that payload to sharpen a convenience warning is the wrong
   * trade. A name match is noisier, which is survivable because this warns
   * and never blocks.
   */
  const duplicateAthlete = useMemo(() => {
    const name = athleteFullName.trim().toLowerCase().replace(/\s+/g, ' ');
    if (athleteMode !== 'new' || !name) {
      return undefined;
    }
    return roster.find(
      (athlete) =>
        athlete.full_name.trim().toLowerCase().replace(/\s+/g, ' ') === name
        && athlete.athlete_id !== trimmedAthleteId,
    );
  }, [roster, athleteMode, athleteFullName, trimmedAthleteId]);

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
    && (athleteMode === 'new' ? newAthleteReady && !collidingAthlete : true);

  /**
   * Which fields are still holding the submit button down, in the order they
   * appear on screen.
   *
   * The button is gated on EIGHT conditions and used to just grey out. An
   * admin filled in what looked like the whole form, found the button dead,
   * and had nothing to work from -- reported as "it won't let me save", which
   * is exactly what it looks like from the outside. A disabled control that
   * cannot say why is a dead end, and this form is the one a gym uses to
   * onboard its first athlete.
   *
   * Named after the labels on the fields rather than the state variables, so
   * the sentence points at something the reader can see.
   */
  const missingAthleteFields = useMemo(() => {
    const missing: string[] = [];
    if (athleteMode === 'new') {
      if (!athleteFullName.trim()) missing.push('Full name');
      if (!athleteDob.trim()) missing.push('Date of birth');
      if (!athleteWeightClass.trim()) missing.push('Weight class');
      if (!athleteGymStatus) missing.push('Gym status');
      if (!athleteEmergencyContact.trim()) missing.push('Emergency contact note');
      if (!athleteCoachId) missing.push('Coach');
    }
    if (!trimmedAthleteId) missing.push('Athlete record ID');
    if (!athleteAccountId.trim()) missing.push('Sign-in ID');
    return missing;
  }, [
    athleteMode, athleteFullName, athleteDob, athleteWeightClass, athleteGymStatus,
    athleteEmergencyContact, athleteCoachId, trimmedAthleteId, athleteAccountId,
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
      // The sign-in sentence comes from the credential policy, not from this
      // page's memory of it. Every role this form can invite signs in with an
      // emailed link today; the Microsoft branch survives so the sentence
      // stays right if a Microsoft-credential role ever becomes invitable.
      const signInSentence =
        requiredCredentialFor({ role: inviteRole as PilotRole }) === 'magic_link'
          ? `They sign in with an email link: on the login page they enter ${email} and the link arrives in their inbox. No Microsoft account is needed.`
          : 'They must also be a guest in the PPBF Microsoft tenant before they can sign in.';
      setNotice(
        inviteRole === 'parent'
          ? `${email} is now a guardian of ${linkedAthleteName} and will see that athlete and no one else. ${signInSentence}`
          : `${email} is now a ${roleLabel(inviteRole)} in your gym. ${signInSentence}`,
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
   * family with an account that signs in and shows them nothing. It also
   * refuses while that guardian's media consent for that athlete stands
   * withdrawn -- removing the link would drop the withdrawal out of the
   * consent check rather than reverse it. Both refusals arrive as a 403 with
   * the server's own wording, which is shown verbatim below; neither is
   * re-stated here, so the two cannot drift apart.
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
    // Back to untouched, so the next athlete gets a fresh suggestion rather
    // than an empty box -- the roster has just grown by one, so the suggestion
    // has moved on too.
    setAthleteIdTouched(false);
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
    // The EFFECTIVE id, not the raw state. Until the admin edits the field it
    // shows the suggested next ath-NNN while `athleteId` is still empty, so
    // submitting the raw value here would post an empty athlete_id against a
    // form that visibly reads ath-005. Same value the button gated on.
    const recordId = trimmedAthleteId;

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

      const createPayload = (await createResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string; activation_code?: string; expires_at?: string };
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

      // The account remains inactive until this one-time code is redeemed.
      if (!createPayload.activation_code || !createPayload.expires_at) throw new Error('Account was created but no activation code was returned');
      setCreatedAthlete({ accountId: createdAccountId, activationCode: createPayload.activation_code, expiresAt: createPayload.expires_at });

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
   * Revoke the old credential and sessions, then issue a fresh one-time code.
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
        body: JSON.stringify({ account_id: accountId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; activation_code?: string; expires_at?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not reset that PIN');
      }
      if (!payload.activation_code || !payload.expires_at) throw new Error('Reset succeeded but no activation code was returned');
      setCreatedAthlete({ accountId, activationCode: payload.activation_code, expiresAt: payload.expires_at });
      setNotice(`${accountId} is inactive until the new one-time activation code is redeemed.`);
      await load();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Could not reset that PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    /* ge-frontoffice: Golden Era Visual 007 scope. This class is the ONLY
       change on this route -- the plank wall, the nameplate tab plaques, the
       screwed register frame and the ruled paper all live in scoped CSS under
       .ge-frontoffice in design-system/current/ppbf-golden-era.css, so every
       control, gate and role check on this console is untouched. It sits on
       the authorised console only: WrongRoleNotice and the loading state stay
       outside the scope on purpose. */
    <main className="ge-frontoffice room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-5xl space-y-[var(--s5)]">
        <header className="relative mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          {/* The desk lamp over the roster. .lamp draws the shade and the pool
              of light under it, and had no app usage at all. */}
          <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
          <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
            <div>
              <p className="t-eyebrow">People</p>
              <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Manage Your Gym</h1>
              <p className="t-body mt-[var(--s3)]">
                Add coaches and staff, and create athlete sign-ins.
                {organizationId && (
                  <>
                    {' '}Gym: <span className="t-data text-[color:var(--bone-100)]">{organizationId}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-[var(--s3)]">
              {/* Board members are appointed to a seat, not added to the gym
                  roster, so the two surfaces are separate. Only an
                  organization admin reaches this markup -- a platform owner is
                  shown WrongRoleNotice before the console renders. */}
              <Link href="/admin/board-seats" className="btn btn--ghost">
                Board Seats
              </Link>
              <Link href="/admin" className="btn btn--ghost">
                Admin Home
              </Link>
            </div>
          </div>
        </header>

        {/* The plaintext code is intentionally shown once. */}
        {createdAthlete && (
          <section className="frame">
            <span className="rivet rivet--tl" />
            <span className="rivet rivet--tr" />
            <span className="rivet rivet--bl" />
            <span className="rivet rivet--br" />
            <div className="frame-in mat-leather p-[var(--s5)]">
              <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                <div>
                  <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Activation code for {createdAthlete.accountId}</h2>
                  <p className="t-body mt-[var(--s2)]">
                    Tell them these two things. They will have to choose their own PIN the first time they sign in, and
                    you will never see what they pick.
                  </p>
                </div>
                <button type="button" onClick={() => setCreatedAthlete(null)} className="btn btn--ghost">
                  Done
                </button>
              </div>

              <dl className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2">
                <div className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)]">
                  <dt className="t-label">Sign-in ID</dt>
                  <dd className="t-data mt-[var(--s2)] text-[length:var(--t-lg)] text-[color:var(--bone-100)]">{createdAthlete.accountId}</dd>
                </div>
                <div className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)]">
                  <dt className="t-label">One-time activation code</dt>
                  <dd className="t-data mt-[var(--s2)] text-[length:var(--t-lg)] tracking-[0.2em] text-[color:var(--bone-100)]">{createdAthlete.activationCode}</dd>
                </div>
              </dl>

              <p className="t-muted mt-[var(--s3)]">
                This code is shown only once and expires {formatGymDateTime(createdAthlete.expiresAt) ?? 'at the stated expiry time'}. The athlete stays inactive until they redeem it and choose their own PIN.
              </p>
            </div>
          </section>
        )}

        {error && (
          <div role="alert" className="alert alert--critical">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              <p className="alert-msg">{error}</p>
            </div>
          </div>
        )}
        {notice && (
          <div className="alert alert--success">
            <span className="alert-icon" aria-hidden="true">✓</span>
            <div className="alert-body">
              <p className="alert-msg">{notice}</p>
            </div>
          </div>
        )}

        <nav className="mat-leather flex flex-wrap gap-[var(--s2)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s2)]">
          {([
            ['people', `Everyone${members.length ? ` (${members.length})` : ''}`],
            ['invite-staff', 'Add Coach, Staff Or Guardian'],
            ['add-athlete', 'Add Athlete'],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`min-h-[44px] flex-1 rounded-[var(--r-md)] border px-[var(--s4)] text-[length:var(--t-sm)] font-bold uppercase tracking-[0.1em] transition ${
                tab === key
                  ? 'border-[color:var(--brass-700)] bg-[var(--accent-strong)] text-[color:var(--accent-ink)]'
                  : 'border-transparent bg-transparent text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
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
              <div className="rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] p-[var(--s4)]">
                <p className="text-[length:var(--t-sm)] font-bold text-[color:var(--locked-ink)]">
                  ▲ {strandedGuardians.length} guardian{strandedGuardians.length === 1 ? '' : 's'} linked to no athlete
                </p>
                <p className="t-body mt-[var(--s2)]">
                  {strandedGuardians.length === 1 ? 'This account signs in' : 'These accounts sign in'} successfully and
                  then {strandedGuardians.length === 1 ? 'shows' : 'show'} no children at all. Add the same email
                  address again on “Add Coach, Staff Or Guardian”, choose Parent / Guardian, and name their athlete.
                </p>
                <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                  {strandedGuardians.map((guardian) => (
                    <li key={guardian.account_id} className="t-data truncate">
                      {guardian.login_email || guardian.account_id}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {members.some((member) => member.role === 'parent') && !guardianLinksAvailable && (
              <p
                role="status"
                className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]"
              >
                Guardian links could not be read, so this list cannot say which children each Parent / Guardian sees.
                Reload the page to try again.
              </p>
            )}

            {pendingAthletes.length > 0 && (
              <div className="mat-leather--raised rounded-[var(--r-md)] border border-[color:var(--restricted)] p-[var(--s4)]">
                <p className="flex flex-wrap items-center gap-[var(--s3)]">
                  <span className="badge badge--restricted"><i>▲</i>{pendingAthletes.length} Pending</span>
                  <span className="text-[length:var(--t-sm)] font-bold text-[color:var(--bone-100)]">
                    {pendingAthletes.length === 1 ? 'athlete cannot' : 'athletes cannot'} sign in yet
                  </span>
                </p>
                <p className="t-body mt-[var(--s2)]">
                  Give them their sign-in ID and one-time activation code. If they have forgotten
                  where they are, “Issue New Activation Code” revokes the old credential and sessions.
                </p>
              </div>
            )}

            <div className="frame">
              <span className="rivet rivet--tl" />
              <span className="rivet rivet--tr" />
              <span className="rivet rivet--bl" />
              <span className="rivet rivet--br" />
              {/* The roster is THE office table, and it was a <ul>: a stack of
                  rows with hand-rolled dividers, the one list in the building
                  that most obviously wants ruling. .ledger on .mat-paper is
                  what an office keeps a register on. .pap rides along because
                  .mat-paper restates the t-* inks for a light ground and .pap
                  restates the .empty ones, and the empty roster lives here. */}
              <div className="frame-in mat-paper pap">
              {loading ? (
                <p className="t-body p-[var(--s5)]">Loading your gym roster...</p>
              ) : members.length === 0 ? (
                /* "Nobody here yet" is the empty state ROOM-PURPOSE-DNA names
                   for this room by name, and it was hand-rolled in raw
                   utilities while seventeen sibling pages used .empty. It is on
                   the system now, and it carries the invite button the DNA also
                   names -- an empty roster that only tells you to go and do it
                   somewhere else is not a front desk. */
                <div className="empty">
                  <div className="empty-glyph" aria-hidden="true">⌾</div>
                  <div className="empty-title">Nobody here yet.</div>
                  <p className="empty-msg">
                    Start by adding a coach, or create your first athlete account.
                  </p>
                  <div className="empty-action">
                    <button type="button" onClick={() => setTab('invite-staff')} className="btn">
                      Add A Coach Or Guardian
                    </button>
                    <button type="button" onClick={() => setTab('add-athlete')} className="btn btn--ghost">
                      Add An Athlete
                    </button>
                  </div>
                </div>
              ) : (
                /* The scroller is a child of .frame-in, which sets
                   overflow:hidden unlayered -- a layered overflow-x utility on
                   the same element would never win. */
                <div className="overflow-x-auto">
                <table className="ledger">
                  <caption className="text-left">Everyone in this gym</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Role</th>
                      <th scope="col">Sign-in</th>
                      <th scope="col">Sees</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                  {members.map((member) => {
                    const isGuardian = member.role === 'parent';
                    const memberLinks = guardianLinksByAccount.get(member.account_id) || [];
                    const linkCount = !isGuardian ? null : guardianLinksAvailable ? memberLinks.length : null;
                    const status = signInStatus(member, linkCount);
                    const isPinAthlete = member.auth_provider === 'ppbf_local' && member.role === 'athlete';

                    return (
                      <tr key={member.account_id}>
                        <td className="font-bold">{member.login_email || member.account_id}</td>
                        <td>
                          {roleLabel(member.role)}
                          {member.athlete_id && <span className="ledger-id"> · Athlete ID {member.athlete_id}</span>}
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              status.tone === 'ok'
                                ? 'badge--cleared'
                                : status.tone === 'pending'
                                  ? 'badge--restricted'
                                  : 'badge--locked'
                            }`}
                          >
                            <i>{status.tone === 'ok' ? '✓' : status.tone === 'pending' ? '▲' : '✕'}</i>
                            {status.label}
                          </span>
                        </td>
                        <td>
                          {/* Exactly which children this adult can open. A
                              guardian row without it says nothing about the
                              only thing the account does. */}
                          {!isGuardian && <span aria-hidden="true">—</span>}
                          {isGuardian && guardianLinksAvailable && memberLinks.length > 0 && (
                            <ul className="space-y-[var(--s1)]">
                              {memberLinks.map((link) => {
                                const confirming =
                                  pendingUnlink?.accountId === member.account_id
                                  && pendingUnlink?.athleteId === link.athlete_id;

                                return (
                                  <li
                                    key={link.athlete_id}
                                    className="flex flex-wrap items-center gap-[var(--s2)]"
                                  >
                                    <span>
                                      Sees <span className="font-bold">{link.athlete_full_name}</span>{' '}
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
                                          className="btn btn--danger px-[var(--s4)] text-[length:var(--t-xs)] disabled:opacity-50"
                                        >
                                          Confirm Remove
                                        </button>
                                        {/* .btn--ghost is bone text on a
                                            translucent black wash, tuned for
                                            leather; the register is paper now
                                            and a lever carries its own dark
                                            surface. */}
                                        <button
                                          type="button"
                                          disabled={busy}
                                          onClick={() => setPendingUnlink(null)}
                                          className="btn--lever disabled:opacity-50"
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
                                        className="btn--lever disabled:opacity-50"
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
                            /* The state itself is on the Sign-in badge
                               ("Linked to no athlete — would see nothing"), so
                               this line is the repair instruction and takes the
                               register's own ink. --restricted-ink is a light
                               ink for a dark ground and would have vanished on
                               the sheet. */
                            <p className="max-w-[34ch]">
                              This guardian resolves no children, so they sign in to an empty page. Invite the same
                              email address again on “Add Coach, Staff Or Guardian” and name the athlete to repair it.
                            </p>
                          )}
                        </td>

                        <td>
                          {isPinAthlete ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleResetToStartingPin(member.account_id)}
                              className="btn--lever whitespace-nowrap disabled:opacity-50"
                            >
                              Issue New Activation Code
                            </button>
                          ) : (
                            <span aria-hidden="true">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  </tbody>
                </table>
                </div>
              )}
              </div>
            </div>
          </section>
        )}

        {tab === 'invite-staff' && (
          <form onSubmit={inviteStaff} className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <div>
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Add a coach, staff member, or guardian</h2>
              <p className="t-body mt-[var(--s3)]">
                Coaches, staff, volunteers and guardians sign in with an emailed link — no password and no
                Microsoft account. Enter the email address the link should reach.
              </p>
            </div>

            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <p className="t-eyebrow">One step</p>
              <p className="t-body mt-[var(--s2)]">
                This form gives them their role. As soon as it is saved, they can go to the login page,
                choose Email Link, enter this address, and sign in from their inbox. No Entra ID guest
                invite is involved for any role on this form.
              </p>
            </div>

            <div className="field">
              <label htmlFor="invite-email" className="t-label">
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="coach@example.com"
                className="input"
              />
            </div>

            <fieldset>
              <legend className="t-label">Role</legend>
              <div className="mt-[var(--s2)] space-y-[var(--s2)]">
                {STAFF_ROLES.map((option) => {
                  const blockedReason = option.value === 'parent' ? parentInviteBlockedReason : null;

                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-[var(--s3)] rounded-[var(--r-md)] border p-[var(--s3)] transition ${
                        blockedReason
                          ? 'mat-leather cursor-not-allowed border-[color:var(--hide-700)] opacity-70'
                          : inviteRole === option.value
                            ? 'mat-leather--raised cursor-pointer border-[color:var(--brass-400)] bg-[rgb(var(--brass-400-rgb)_/_.07)]'
                            : 'mat-leather cursor-pointer border-[color:var(--hide-700)] hover:border-[color:var(--brass-700)]'
                      }`}
                    >
                      <input
                        type="radio"
                        name="invite-role"
                        value={option.value}
                        checked={inviteRole === option.value}
                        disabled={Boolean(blockedReason)}
                        onChange={() => setInviteRole(option.value)}
                        className="mt-1 accent-[var(--brass-500)]"
                      />
                      <span>
                        <span className="block text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{option.label}</span>
                        <span className="t-muted mt-[var(--s1)] block">{option.blurb}</span>
                        {blockedReason && (
                          <span className="mt-[var(--s1)] block text-[length:var(--t-xs)] font-semibold text-[color:var(--restricted-ink)]">
                            ▲ {blockedReason}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="t-muted mt-[var(--s3)]">
                Adding another gym admin is a platform-owner action — ask PPBF to do it.
              </p>
            </fieldset>

            {/* A parent account reads the gym through this link and nothing
                else, so it is captured with the invite rather than left for a
                screen that does not exist. */}
            {inviteRole === 'parent' && !parentInviteBlockedReason && (
              <fieldset className="space-y-[var(--s4)] rounded-[var(--r-md)] border border-[color:var(--hide-600)] p-[var(--s4)]">
                <legend className="t-eyebrow px-[var(--s1)]">
                  Which child
                </legend>
                <p className="t-body">
                  A guardian sees only the athletes named here, and this is the only screen that links them. To give a
                  guardian a second child, add the same email address again and choose the other athlete.
                </p>

                <div className="field">
                  <label htmlFor="guardian-full-name" className="t-label">
                    Guardian&apos;s full name
                  </label>
                  <input
                    id="guardian-full-name"
                    type="text"
                    required
                    value={guardianFullName}
                    onChange={(event) => setGuardianFullName(event.target.value)}
                    placeholder="Dana Johnson"
                    className="input"
                  />
                </div>

                <div className="field">
                  <label htmlFor="guardian-athlete" className="t-label">
                    Athlete
                  </label>
                  <p className="t-muted mb-[var(--s2)]">
                    Check this carefully — it decides whose records this adult can open.
                  </p>
                  <select
                    id="guardian-athlete"
                    required
                    value={guardianAthleteId}
                    onChange={(event) => setGuardianAthleteId(event.target.value)}
                    className="select"
                  >
                    <option value="">Choose an athlete...</option>
                    {roster.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>
                        {athlete.full_name} ({athlete.athlete_id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="guardian-relationship" className="t-label">
                    Relationship to the athlete
                  </label>
                  <select
                    id="guardian-relationship"
                    required
                    value={guardianRelationship}
                    onChange={(event) => setGuardianRelationship(event.target.value)}
                    className="select"
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
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding...' : 'Add To My Gym'}
            </button>
          </form>
        )}

        {tab === 'add-athlete' && (
          <form onSubmit={addAthlete} className="mat-leather space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <div>
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Add an athlete</h2>
              <p className="t-body mt-[var(--s3)]">
                This puts the athlete in your gym and gives you a sign-in ID plus a one-time activation code
                every new athlete gets. They have to choose their own PIN the first time they sign in — you never see it.
              </p>
            </div>

            <fieldset>
              <legend className="t-label">Where is this athlete now?</legend>
              <div className="mt-[var(--s2)] space-y-[var(--s2)]">
                {ATHLETE_MODES.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-[var(--s3)] rounded-[var(--r-md)] border p-[var(--s3)] transition ${
                      athleteMode === option.value
                        ? 'mat-leather--raised border-[color:var(--brass-400)] bg-[rgb(var(--brass-400-rgb)_/_.07)]'
                        : 'mat-leather border-[color:var(--hide-700)] hover:border-[color:var(--brass-700)]'
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
                      }}
                      className="mt-1 accent-[var(--brass-500)]"
                    />
                    <span>
                      <span className="block text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{option.label}</span>
                      <span className="t-muted mt-[var(--s1)] block">{option.blurb}</span>
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
                className="space-y-[var(--s4)] rounded-[var(--r-md)] border border-[color:var(--hide-600)] p-[var(--s4)] disabled:opacity-70"
              >
                <p className="t-eyebrow">Athlete Details</p>

                <div className="field">
                  <label htmlFor="athlete-id" className="t-label">
                    Athlete record ID
                  </label>
                  <p className="t-muted mb-[var(--s2)]">
                    Permanent id for their record in your roster — every session, goal, and review hangs off it.
                    {athleteIdTouched ? (
                      <>
                        {' '}
                        Short and unique, like <code>ath-001</code>.
                      </>
                    ) : (
                      ` Filled in with the next free one for your gym (${suggestedAthleteId}). Change it if your gym numbers differently.`
                    )}
                  </p>
                  <input
                    id="athlete-id"
                    type="text"
                    required
                    value={effectiveAthleteId}
                    onChange={(event) => {
                      setAthleteIdTouched(true);
                      setAthleteId(event.target.value.trim());
                    }}
                    placeholder="ath-001"
                    className="input font-mono"
                  />
                  {/*
                    The duplicate that actually costs something, and the reason
                    the suggestion above could not ship alone. Two records can
                    never share an id -- the create route is create-only and the
                    primary key refuses it. What nothing prevents is the same
                    CHILD entered twice under two ids, leaving one kid with two
                    sets of sessions, goals and reviews that can never be added
                    together.

                    Auto-filling the id makes that MORE likely, because it
                    removes the moment where an admin types ath-001, finds it
                    taken, and thinks "hold on, is this the same kid?".

                    It warns and never blocks: siblings share surnames and twins
                    share birthdays, so a match on both is a question, not proof.
                  */}
                  {duplicateAthlete && (
                    <p className="mt-2 rounded-xl border border-[color:var(--brass-600)] bg-[color-mix(in_srgb,var(--brass-600)_10%,white)] px-3 py-2 text-xs font-semibold">
                      {duplicateAthlete.full_name} is already on your roster as {duplicateAthlete.athlete_id}. If that
                      is this same athlete, switch to “Already on the roster” above rather than adding a second record
                      — otherwise their sessions, goals and reviews end up split across two. If they are different
                      people who share a name, carry on.
                    </p>
                  )}
                  {collidingAthlete && (
                    <p className="mt-[var(--s2)] rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] font-semibold text-[color:var(--locked-ink)]">
                      ▲ {collidingAthlete.full_name} already holds record ID {collidingAthlete.athlete_id}. Pick a
                      different ID — or, if that is this same athlete, switch to “Already on the roster”.
                    </p>
                  )}
                  {athleteDetailsLocked && (
                    <p className="mt-[var(--s2)] text-[length:var(--t-xs)] font-semibold text-[color:var(--cleared-ink)]">
                      ✓ Roster record saved, so these details are locked — they are not resent when you submit again.
                      Finish by giving them a sign-in ID below. To start a different athlete instead, switch modes
                      above and back.
                    </p>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="athlete-full-name" className="t-label">
                    Full name
                  </label>
                  <input
                    id="athlete-full-name"
                    type="text"
                    required
                    value={athleteFullName}
                    onChange={(event) => setAthleteFullName(event.target.value)}
                    placeholder="Alex Johnson"
                    className="input"
                  />
                </div>

                <div className="grid gap-[var(--s4)] sm:grid-cols-2">
                  <div className="field">
                    <label htmlFor="athlete-dob" className="t-label">
                      Date of birth
                    </label>
                    <input
                      id="athlete-dob"
                      type="date"
                      required
                      value={athleteDob}
                      onChange={(event) => setAthleteDob(event.target.value)}
                      className="input"
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="athlete-weight-class" className="t-label">
                      Weight class
                    </label>
                    <input
                      id="athlete-weight-class"
                      type="text"
                      required
                      value={athleteWeightClass}
                      onChange={(event) => setAthleteWeightClass(event.target.value)}
                      placeholder="middleweight"
                      className="input"
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="athlete-gym-status" className="t-label">
                    Status in the gym
                  </label>
                  <select
                    id="athlete-gym-status"
                    required
                    value={athleteGymStatus}
                    onChange={(event) => setAthleteGymStatus(event.target.value)}
                    className="select"
                  >
                    {GYM_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  {/* CT-15: this is a free-text NOTE, not the authoritative
                      emergency contact record -- pilot.emergency_contacts
                      (structured: name, relationship, phone, email) is, and it
                      is entered separately through intake review. There is no
                      existing athlete yet at this point in the form, so there
                      is nothing structured to show here the way
                      /admin/athletes shows it for an existing one; the fix on
                      this screen is stating plainly what this field is. */}
                  <label htmlFor="athlete-emergency-contact" className="t-label">
                    Emergency contact note
                  </label>
                  <p className="t-muted mb-[var(--s2)]">
                    Who to call, and the number. Required — an athlete cannot train without one on file. This is a
                    note, not the verified contact record; add a structured emergency contact through intake review
                    when one exists.
                  </p>
                  <input
                    id="athlete-emergency-contact"
                    type="text"
                    required
                    value={athleteEmergencyContact}
                    onChange={(event) => setAthleteEmergencyContact(event.target.value)}
                    placeholder="Dana Johnson (mother) 555-0101"
                    className="input"
                  />
                </div>

                <div className="field">
                  <label htmlFor="athlete-coach" className="t-label">
                    Coach
                  </label>
                  <p className="t-muted mb-[var(--s2)]">
                    {coachOptions.length > 0
                      ? 'A coach only sees the athletes assigned to them. Every athlete record has to name one, so pick whoever will be working with them.'
                      : 'No coaches in your gym yet, and an athlete record has to name one — add a coach on the “Add Coach, Staff Or Guardian” tab, then come back here.'}
                  </p>
                  <select
                    id="athlete-coach"
                    required
                    value={athleteCoachId}
                    onChange={(event) => setAthleteCoachId(event.target.value)}
                    className="select"
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
                <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-eyebrow">
                    Nobody is waiting
                  </p>
                  <p className="t-body mt-[var(--s2)]">
                    {roster.length === 0
                      ? 'There are no athlete records in your gym yet, so there is nothing to attach a login to. Choose “New to the gym” above.'
                      : 'Every athlete on your roster already has a sign-in. Choose “New to the gym” above to add someone else.'}
                  </p>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="athlete-id-picker" className="t-label">
                    Which athlete
                  </label>
                  <p className="t-muted mb-[var(--s2)]">
                    Only athletes with no sign-in yet are listed — {unlinkedAthletes.length} of {roster.length} on your
                    roster.
                  </p>
                  <select
                    id="athlete-id-picker"
                    required
                    value={athleteId}
                    onChange={(event) => setAthleteId(event.target.value)}
                    className="select"
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
              <div className="field">
                <label htmlFor="athlete-id" className="t-label">
                  Athlete record ID
                </label>
                <p className="t-muted mb-[var(--s2)]">
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
                  className="input font-mono"
                />
              </div>
            )}

            <div className="field">
              <label htmlFor="athlete-account-id" className="t-label">
                Sign-in ID
              </label>
              <p className="t-muted mb-[var(--s2)]">
                What the athlete types to sign in. Keep it simple and unique, like <code>jsmith</code>.
              </p>
              <input
                id="athlete-account-id"
                type="text"
                required
                value={athleteAccountId}
                onChange={(event) => setAthleteAccountId(event.target.value.trim())}
                placeholder="jsmith"
                className="input font-mono"
              />
            </div>

            {/*
              A disabled button that cannot say why is a dead end, and this is
              the form a gym uses to onboard its first athlete. Rendered above
              the button so it is read before the thing that will not respond,
              and only while something is actually missing.
            */}
            {!busy && missingAthleteFields.length > 0 && (
              <p
                aria-live="polite"
                className="rounded-xl border border-[rgba(0,0,0,0.16)] bg-[color-mix(in_srgb,var(--brass-600)_8%,white)] px-3 py-2 text-xs font-semibold"
              >
                Still needed before this can be saved: {missingAthleteFields.join(', ')}.
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !canSubmitAthlete}
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
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
      <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <p className="t-body">Loading...</p>
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
