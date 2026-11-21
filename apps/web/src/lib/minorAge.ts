/**
 * Who is a minor, by date of birth, on the gym's calendar day: the one rule.
 *
 * Moved here unchanged from src/server/pilot/wallDisplay.ts (lane AS-10, PR
 * AS10-1) so a page can ask the same question the server asks without a
 * second copy of the rule: wallDisplay.ts imports node:crypto and cannot load
 * in a browser. wallDisplay.ts re-exports all three, so every server import
 * (guardianAccess.ts's guardianLinkEnded included) is unchanged.
 */
import { gymDayIso } from '@/src/lib/gymTime';

export const ADULT_AGE_YEARS = 18;

/**
 * Age in whole years on the GYM's calendar day, or null when the date of birth
 * is missing or unreadable.
 *
 * "Today" is read in the gym's zone, never from the server clock's own date
 * parts. A container running in UTC is already on tomorrow from 8pm Eastern
 * (7pm in winter), so UTC parts made an athlete an adult the evening before
 * their 18th birthday -- during the class -- and every minor protection that
 * asks isMinor() switched off a night early. An athlete is a minor until local
 * midnight at the start of their birthday, and not a minute before.
 */
export function ageInYears(dob: string | null | undefined, now: Date): number | null {
  if (typeof dob !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // An unusable `now` throws, as it did before: a null age reads as "no date
  // of birth", which is not what happened.
  const today = gymDayIso(now);
  if (!today) throw new RangeError('Invalid time value');
  const [yearNow, monthNow, dayNow] = today.split('-').map(Number);
  let age = yearNow - year;
  if (monthNow < month || (monthNow === month && dayNow < day)) {
    age -= 1;
  }
  return age;
}

/**
 * Unknown age is treated as a minor. A gym whose records are incomplete must
 * not have that read as "adult, publish freely".
 */
export function isMinor(dob: string | null | undefined, now: Date): boolean {
  const age = ageInYears(dob, now);
  return age === null || age < ADULT_AGE_YEARS;
}
