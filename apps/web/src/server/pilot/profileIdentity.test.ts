import {
  buildFightCard,
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
    expect(PROGRAM_LABEL.fitness).toMatch(/Programme$/);
    expect(PROGRAM_LABEL.competitive).toMatch(/Programme$/);
    expect(PROGRAM_LABEL.recreational).toMatch(/Programme$/);
    expect(PROGRAM_LABEL.youth_mentorship).toMatch(/Programme$/);
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
  };

  it('is the same object for a fitness member as for a competitor', () => {
    const fitness = buildFightCard({ ...base, program: 'fitness' }, now);
    const competitor = buildFightCard({ ...base, program: 'competitive' }, now);
    expect(Object.keys(fitness).sort()).toEqual(Object.keys(competitor).sort());
    expect(Object.values(fitness).filter((v) => v === null).length)
      .toBe(Object.values(competitor).filter((v) => v === null).length);
    expect(fitness.programLabel).toBe('Fitness Programme');
    expect(competitor.programLabel).toBe('Competitive Programme');
  });

  it('carries initials for the plate whether or not a photo is available', () => {
    expect(buildFightCard(base, now).initials).toBe('SA');
    expect(buildFightCard({ ...base, photoAvailable: true }, now).initials).toBe('SA');
  });

  it('gives the coach initials only when there is a coach', () => {
    expect(buildFightCard(base, now).coachInitials).toBeNull();
    expect(buildFightCard({ ...base, coachName: 'Ray Nolan' }, now).coachInitials).toBe('RN');
  });
});
