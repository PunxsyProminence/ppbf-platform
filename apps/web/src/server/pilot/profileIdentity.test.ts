import type { PilotRole } from './contracts';
import {
  buildFightCard,
  cardSubjectQuery,
  CORNER_LABEL,
  initialsFor,
  isNicknameLocked,
  NICKNAME_LOCK_HOURS,
  NICKNAME_MAX_LENGTH,
  normalizeCorner,
  normalizeNickname,
  normalizeProgram,
  PROGRAM_CHOICES,
  PROGRAM_LABEL,
  timeAtGym,
  validateNickname,
} from './profileIdentity';

describe('the corner is a closed vocabulary', () => {
  it('accepts the two corners', () => {
    expect(normalizeCorner('red')).toBe('red');
    expect(normalizeCorner('BLUE')).toBe('blue');
    expect(normalizeCorner(' red ')).toBe('red');
  });

  it('falls to "none" for anything else, including a colour name', () => {
    for (const value of ['green', 'purple', '#A81E22', '', null, undefined, 42, {}]) {
      expect(normalizeCorner(value)).toBe('none');
    }
  });

  it('gives every corner words, because colour is never the only channel', () => {
    expect(CORNER_LABEL.red).toMatch(/red/i);
    expect(CORNER_LABEL.blue).toMatch(/blue/i);
    expect(CORNER_LABEL.none.length).toBeGreaterThan(0);
  });
});

describe('every programme is a finished statement, not a lesser version of another', () => {
  it('labels each programme without ranking it', () => {
    for (const program of PROGRAM_CHOICES) {
      expect(PROGRAM_LABEL[program].length).toBeGreaterThan(0);
    }
    // The words that would turn a card into a stub. A fitness-only member's
    // card must never describe them by what they are not.
    for (const program of PROGRAM_CHOICES) {
      expect(PROGRAM_LABEL[program].toLowerCase()).not.toMatch(/non-|basic|general|other|limited|entry/);
    }
  });

  it('gives fitness the same shape of label as competitive', () => {
    expect(PROGRAM_LABEL.fitness).toMatch(/Program$/);
    expect(PROGRAM_LABEL.competitive).toMatch(/Program$/);
    expect(PROGRAM_LABEL.recreational).toMatch(/Program$/);
    expect(PROGRAM_LABEL.youth_mentorship).toMatch(/Program$/);
  });

  it('never infers a programme from an unknown value', () => {
    expect(normalizeProgram('active')).toBe('unstated');
    expect(normalizeProgram('boxer')).toBe('unstated');
    expect(normalizeProgram(null)).toBe('unstated');
    expect(normalizeProgram('competitive')).toBe('competitive');
  });
});

describe('ring names are bounded by shape', () => {
  it('accepts ordinary ring names', () => {
    for (const value of ['Sugar', "O'Malley", 'The Groundhog', 'Lefty-Jo', 'Ana Sofía', 'Round 5']) {
      expect(validateNickname(value)).toMatchObject({ ok: true });
    }
  });

  it('refuses anything shorter than two characters or longer than the cap', () => {
    expect(validateNickname('A')).toMatchObject({ ok: false, reason: 'too_short' });
    expect(validateNickname('')).toMatchObject({ ok: false, reason: 'too_short' });
    expect(validateNickname('x'.repeat(NICKNAME_MAX_LENGTH + 1)))
      .toMatchObject({ ok: false, reason: 'too_long' });
    expect(validateNickname('x'.repeat(NICKNAME_MAX_LENGTH))).toMatchObject({ ok: true });
  });

  it('counts the cap in code points, so an emoji-heavy name cannot buy extra room', () => {
    // Also refused outright by the allow-list; this asserts the measurement.
    const astral = '🥊'.repeat(NICKNAME_MAX_LENGTH);
    expect([...astral].length).toBe(NICKNAME_MAX_LENGTH);
    expect(astral.length).toBeGreaterThan(NICKNAME_MAX_LENGTH);
    expect(validateNickname(astral).ok).toBe(false);
  });

  it('refuses the delivery mechanisms -- links, markup, addresses, emoji', () => {
    for (const value of [
      'http://evil.example',
      'www.example.com',
      'me@example.com',
      '<script>x</script>',
      'call 5551234567',
      '555-123-4567 now',
      'Sugar 🥊',
      'a/b\\c',
    ]) {
      expect(validateNickname(value).ok).toBe(false);
    }
  });

  it('refuses a name made only of punctuation or digits', () => {
    expect(validateNickname('---')).toMatchObject({ ok: false });
    expect(validateNickname('12')).toMatchObject({ ok: false, reason: 'no_letters' });
  });

  it('strips invisible characters before measuring, so they cannot smuggle length or reorder text', () => {
    // Zero-width space, and a right-to-left override that would reverse what a
    // coach reads on screen.
    expect(normalizeNickname('Su​gar')).toBe('Sugar');
    expect(normalizeNickname('Sug‮ar')).toBe('Sugar');
    expect(normalizeNickname('  Sugar   Ray  ')).toBe('Sugar Ray');
    expect(validateNickname('Sug‮ar')).toMatchObject({ ok: true, value: 'Sugar' });
  });

  it('normalizes before storing, so the stored value is what a coach will read', () => {
    expect(validateNickname('  The   Kid ')).toMatchObject({ ok: true, value: 'The Kid' });
  });
});

describe('a takedown outlasts the argument', () => {
  const now = new Date('2026-08-03T12:00:00Z');

  it('is not locked when nothing was cleared', () => {
    expect(isNicknameLocked(null, now)).toBe(false);
    expect(isNicknameLocked(undefined, now)).toBe(false);
  });

  it('is locked for the stated window and free afterwards', () => {
    const justCleared = new Date(now.getTime() - 60_000).toISOString();
    const longAgo = new Date(now.getTime() - (NICKNAME_LOCK_HOURS + 1) * 3_600_000).toISOString();
    expect(isNicknameLocked(justCleared, now)).toBe(true);
    expect(isNicknameLocked(longAgo, now)).toBe(false);
  });

  it('treats an unreadable clear timestamp as still locked', () => {
    // "Somebody took this down and the record of when is broken" does not read
    // as "so it is fine now".
    expect(isNicknameLocked('not a date', now)).toBe(true);
  });
});

describe('the plate never renders blank', () => {
  it('strikes two initials from a full name', () => {
    expect(initialsFor('Sofia Alvarez')).toBe('SA');
    expect(initialsFor('Mary Jane Watson')).toBe('MW');
  });

  it('handles a single name', () => {
    expect(initialsFor('Prince')).toBe('P');
  });

  it('falls back to a struck dash rather than emptiness', () => {
    for (const value of ['', '   ', null, undefined, '---', '12345']) {
      expect(initialsFor(value).length).toBeGreaterThan(0);
    }
    expect(initialsFor('')).toBe('—');
  });

  it('uppercases and handles accented letters', () => {
    expect(initialsFor('ana sofía')).toBe('AS');
    expect(initialsFor('Ólafur Þór')).toBe('ÓÞ');
  });
});

describe('time at the gym is coarse on purpose', () => {
  const now = new Date('2026-08-03T00:00:00Z');

  it('never prints a joining date', () => {
    expect(timeAtGym('2024-02-11T00:00:00Z', now)).not.toMatch(/2024|02|11/);
  });

  it('reads in the words a person would use', () => {
    expect(timeAtGym(new Date(now.getTime() - 5 * 86_400_000), now)).toBe('New this month');
    expect(timeAtGym(new Date(now.getTime() - 40 * 86_400_000), now)).toBe('1 month at the gym');
    expect(timeAtGym(new Date(now.getTime() - 200 * 86_400_000), now)).toMatch(/months at the gym/);
    expect(timeAtGym(new Date(now.getTime() - 400 * 86_400_000), now)).toBe('1 year at the gym');
    expect(timeAtGym(new Date(now.getTime() - 1200 * 86_400_000), now)).toBe('3 years at the gym');
  });

  it('returns null rather than guessing', () => {
    expect(timeAtGym(null, now)).toBeNull();
    expect(timeAtGym('nonsense', now)).toBeNull();
    expect(timeAtGym(new Date(now.getTime() + 86_400_000), now)).toBeNull();
  });
});

describe('the card', () => {
  const now = new Date('2026-08-03T00:00:00Z');
  const base = {
    accountId: 'acct-1',
    fullName: 'Sofia Alvarez',
    ringName: null,
    corner: 'none' as const,
    program: 'unstated' as const,
    coachName: null,
    coachAccountId: null,
    coachPhotoAvailable: false,
    memberSince: new Date(now.getTime() - 400 * 86_400_000),
    photoAvailable: false,
    viewerRole: 'coach' as const,
    athleteId: null,
    viewerAccountId: 'acct-viewer',
  };

  it('is the same object for a fitness member as for a competitor', () => {
    const fitness = buildFightCard({ ...base, program: 'fitness' }, now);
    const competitor = buildFightCard({ ...base, program: 'competitive' }, now);
    expect(Object.keys(fitness).sort()).toEqual(Object.keys(competitor).sort());
    expect(Object.values(fitness).filter((v) => v === null).length)
      .toBe(Object.values(competitor).filter((v) => v === null).length);
    expect(fitness.programLabel).toBe('Fitness Program');
    expect(competitor.programLabel).toBe('Competitive Program');
  });

  it('carries initials for the plate whether or not a photo is available', () => {
    expect(buildFightCard(base, now).initials).toBe('SA');
    expect(buildFightCard({ ...base, photoAvailable: true }, now).initials).toBe('SA');
  });

  it('gives the coach initials only when there is a coach', () => {
    expect(buildFightCard(base, now).coachInitials).toBeNull();
    expect(buildFightCard({ ...base, coachName: 'Ray Nolan' }, now).coachInitials).toBe('RN');
  });
  /* OD-2026-10-06-025 ruling 2: families see a coach's display name, never
   * the internal account id. Every role is listed, so a role added to
   * PilotRole later fails `npm run typecheck` here until somebody decides
   * which side of the line it is on. */
  describe('the coach account id, by viewer role', () => {
    const withCoach = { ...base, coachName: 'Ray Nolan', coachAccountId: 'acct-coach-7f3a' };
    const keepsId: Record<PilotRole, boolean> = {
      athlete: false,
      parent: false,
      coach: true,
      admin: true,
      organization_admin: true,
      platform_owner: true,
      board: true,
      volunteer: true,
      staff: true,
    };

    it.each(Object.entries(keepsId))('%s viewer: carries the id = %s', (role, keeps) => {
      const card = buildFightCard({ ...withCoach, viewerRole: role as PilotRole }, now);
      expect(card.coachAccountId).toBe(keeps ? 'acct-coach-7f3a' : null);
      // The name still goes to everyone who gets the card.
      expect(card.coachName).toBe('Ray Nolan');
      if (!keeps) expect(JSON.stringify(card)).not.toContain('acct-coach-7f3a');
    });

    it('passes the name it is given through unchanged: which name a family gets is the route\'s choice', () => {
      // coachNameForViewer (profileCardSubject.ts) picks the family reader;
      // this layer must not rewrite it either way.
      for (const role of Object.keys(keepsId) as PilotRole[]) {
        expect(buildFightCard({ ...withCoach, coachName: 'Coach Ray', viewerRole: role }, now).coachName).toBe('Coach Ray');
      }
    });

    it('leaves a card with no coach as it was', () => {
      const card = buildFightCard({ ...base, viewerRole: 'parent' }, now);
      expect(card.coachName).toBeNull();
      expect(card.coachAccountId).toBeNull();
      expect(card.coachInitials).toBeNull();
      expect(card.coachPortraitPath).toBeNull();
    });
  });

  /* F-119: a family's card carries no account id at all, its own subject's
   * included -- a parent's own id is email-shaped -- and the portraits are
   * addressed by a handle the viewer already holds. */
  describe('the subject account id and the portrait paths, by viewer', () => {
    const PARENT = 'dana.vance@example.test';
    const CHILD = 'acct-child-5';
    const coached = { ...base, coachName: 'Coach Ray', coachAccountId: 'acct-coach-7f3a' };

    it.each(['athlete', 'parent'] as const)("a %s viewer's OWN card: no id, no query", (role) => {
      const card = buildFightCard(
        { ...coached, accountId: PARENT, viewerAccountId: PARENT, viewerRole: role },
        now,
      );
      expect(card.accountId).toBeNull();
      expect(card.portraitPath).toBe('/api/pilot/profile/card/photo');
      expect(card.coachPortraitPath).toBe('/api/pilot/profile/card/coach-photo?coach_name=Coach%20Ray');
      expect(JSON.stringify(card)).not.toContain(PARENT);
      expect(JSON.stringify(card)).not.toContain('@');
    });

    it("a parent's view of their child: addressed by the athlete id, never the child's account", () => {
      const card = buildFightCard(
        { ...coached, accountId: CHILD, athleteId: 'ath-1', viewerAccountId: PARENT, viewerRole: 'parent' },
        now,
      );
      expect(card.accountId).toBeNull();
      expect(card.portraitPath).toBe('/api/pilot/profile/card/photo?athlete_id=ath-1');
      expect(card.coachPortraitPath)
        .toBe('/api/pilot/profile/card/coach-photo?athlete_id=ath-1&coach_name=Coach%20Ray');
      expect(JSON.stringify(card)).not.toContain(CHILD);
      expect(JSON.stringify(card)).not.toContain(PARENT);
    });

    it('a family viewer on a card only an account id can name gets no path: the plate', () => {
      const card = buildFightCard(
        { ...coached, accountId: 'coach@example.test', viewerAccountId: PARENT, viewerRole: 'parent' },
        now,
      );
      expect(card.accountId).toBeNull();
      expect(card.portraitPath).toBeNull();
      expect(card.coachPortraitPath).toBeNull();
      expect(JSON.stringify(card)).not.toContain('@');
    });

    it.each(['coach', 'organization_admin', 'admin', 'platform_owner', 'board', 'volunteer', 'staff'] as const)(
      'a %s viewer keeps the account ids it had',
      (role) => {
        const card = buildFightCard(
          { ...coached, accountId: CHILD, athleteId: 'ath-1', viewerAccountId: 'acct-staff', viewerRole: role },
          now,
        );
        expect(card.accountId).toBe(CHILD);
        expect(card.coachAccountId).toBe('acct-coach-7f3a');
        expect(card.portraitPath).toBe('/api/pilot/profile/card/photo?athlete_id=ath-1');
      },
    );

    it('a family viewer whose only name is their account id is given the floor, not the id', () => {
      // profileDb.staffDisplayName returns the account id when a login has no
      // usable email stem -- for a parent, an email-shaped id.
      const card = buildFightCard(
        { ...base, accountId: PARENT, fullName: PARENT, viewerAccountId: PARENT, viewerRole: 'parent' },
        now,
      );
      expect(card.displayName).toBe('Gym member');
      expect(card.initials).toBe('GM');
      expect(JSON.stringify(card)).not.toContain('@');
    });

    it('a staff viewer is shown the name as before, even when it is the id', () => {
      const card = buildFightCard({ ...base, accountId: 'acct-coach-7f3a', fullName: 'acct-coach-7f3a' }, now);
      expect(card.displayName).toBe('acct-coach-7f3a');
    });

    it('a staff viewer on a staff card is addressed by account id, as before', () => {
      expect(cardSubjectQuery({
        accountId: 'acct-coach-7f3a', athleteId: null, viewerAccountId: 'acct-admin', viewerRole: 'organization_admin',
      })).toBe('?account_id=acct-coach-7f3a');
    });

    it('encodes the handle it puts in a URL', () => {
      expect(cardSubjectQuery({
        accountId: CHILD, athleteId: 'ath 1&x=y', viewerAccountId: PARENT, viewerRole: 'parent',
      })).toBe('?athlete_id=ath%201%26x%3Dy');
    });
  });
});
