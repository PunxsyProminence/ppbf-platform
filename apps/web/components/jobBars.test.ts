import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as buildingMap from './buildingMap';
import { BUILDING } from './buildingMap';
import { BOARD_HOME, JOB_BARS, jobBarFor, type JobItem } from './jobBars';
import { getPilotRoleDestination } from '../src/shared/pilotRoleRouting';
import type { ClubRole } from './roleRoutes';

/**
 * AS-4 4a: each role's job bar, from the App Scrub stage 2 file, section 3.3, as
 * Overwatch quoted it on #2029 (QS = A corrected to the source).
 */

const HREFS = new Set(BUILDING.map((door) => door.href));
const items = (role: ClubRole): JobItem[] => {
  const bar = JOB_BARS[role];
  return bar ? [...bar.sections.flatMap((section) => section.items), ...bar.more] : [];
};
const hrefsOf = (list: readonly JobItem[]) => list.map((item) => item.href);
const BAR_ROLES: ClubRole[] = ['coach', 'parent', 'admin', 'board', 'staff', 'volunteer', 'platform_owner'];

describe('the job bars', () => {
  it('carry the approved sections, in order, for each role', () => {
    const labels = (role: ClubRole) => JOB_BARS[role]?.sections.map((section) => section.label);
    expect(labels('coach')).toEqual(['Home', 'Class', 'Athletes', 'Plan', 'Safety']);
    expect(labels('parent')).toEqual(['Home', 'Safety', 'This week', 'Progress', 'Messages']);
    expect(labels('admin')).toEqual(['Home', 'Members & staff', 'Safety', 'Classes & floor', 'Office']);
    expect(labels('board')).toEqual(['Home', 'Aggregates', 'Escalations', 'Compliance', 'Board hub']);
    expect(labels('staff')).toEqual(['Home', 'Growth', 'More']);
    expect(labels('volunteer')).toEqual(['Home', 'Growth', 'More']);
    expect(labels('platform_owner')).toEqual(['Home', 'Gyms', 'Onboard', 'System']);
  });

  it.each(['coach', 'parent', 'admin', 'staff', 'volunteer', 'platform_owner'] as ClubRole[])(
    "%s: Home is the page the role lands on today",
    (role) => {
      expect(jobBarFor(role)?.sections[0]).toEqual({ label: 'Home', items: [{ href: getPilotRoleDestination(role) }] });
    },
  );

  it('board: Home is where the session lands, its seat or Board Hub', () => {
    expect(jobBarFor('board', { boardSeat: 'treasurer' })?.sections[0].items[0].href).toBe(getPilotRoleDestination('board', 'treasurer'));
    expect(jobBarFor('board')?.sections[0].items[0].href).toBe(getPilotRoleDestination('board', null));
  });

  it('give the athlete no bar (Q14 A, OD-2026-11-19-017), and nobody without a session', () => {
    expect(JOB_BARS.athlete).toBeUndefined();
    expect(jobBarFor('athlete')).toBeNull();
    expect(jobBarFor(null)).toBeNull();
  });

  it.each(BAR_ROLES)('%s: names only existing doors, so no new routes', (role) => {
    for (const href of hrefsOf(items(role))) {
      if (href !== BOARD_HOME) expect(HREFS).toContain(href);
    }
  });

  // One page in two sections only where the source puts its contents in both: the Parent Floor tab
  // holds the support tasks (This week) and Report a Barrier, today's "Tell the coach" (Messages).
  const TWICE: Partial<Record<ClubRole, string[]>> = { parent: ['/parent/dashboard#parent-floor'] };

  it.each(BAR_ROLES)('%s: names no page twice, but for the named exception', (role) => {
    const keys = items(role).map((item) => `${item.href}#${item.tab ?? ''}`);
    const repeated = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
    expect(repeated).toEqual(TWICE[role] ?? []);
    for (const section of JOB_BARS[role]?.sections ?? []) {
      const own = section.items.map((item) => `${item.href}#${item.tab ?? ''}`);
      expect(new Set(own).size).toBe(own.length);
    }
  });

  it.each(BAR_ROLES)('%s: names only pages the role can already open (none is dropped for them)', (role) => {
    const viewer = role === 'board' ? { boardSeat: 'treasurer' as const, boardSeats: ['treasurer' as const] } : {};
    const bar = jobBarFor(role, viewer);
    const given = bar ? [...bar.sections.flatMap((section) => section.items), ...bar.more] : [];
    expect(given).toHaveLength(items(role).length);
  });

  it("lists the athlete page's parts under Athletes, after Passbook, until the athlete page holds them", () => {
    const athletes = hrefsOf(JOB_BARS.coach?.sections.find((section) => section.label === 'Athletes')?.items ?? []);
    expect(athletes.slice(0, 8)).toEqual([
      '/coach/passbook', '/coach/development-blocks', '/coach/assessments', '/coach/mental-skills',
      '/coach/progression-intelligence', '/coach/attempt-log', '/coach/transfer-check', '/coach/cards',
    ]);
  });

  it("keeps the admin's Lab pages out of the bar: Capabilities, System and Door Register are in Search", () => {
    const admin = hrefsOf(items('admin'));
    for (const href of ['/admin', '/admin/system', '/admin/door-register']) expect(admin).not.toContain(href);
  });

  it('opens Parent Hub only on tabs Parent Hub has', () => {
    const hub = readFileSync(path.resolve(__dirname, 'ParentHub.tsx'), 'utf8');
    const tabType = hub.match(/type TabID = ([^;]+);/)?.[1] ?? '';
    const tabs = items('parent').filter((item) => item.tab).map((item) => item.tab as string);
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(tabType).toContain(`'${tab}'`);
      expect(items('parent').find((item) => item.tab === tab)?.href).toBe('/parent/dashboard');
    }
  });
});

describe('a board member\'s bar', () => {
  it("opens Home on their own seat, and shows no other seat's door", () => {
    const bar = jobBarFor('board', { boardSeat: 'treasurer', boardSeats: ['treasurer'] });
    expect(bar?.sections[0]).toEqual({ label: 'Home', items: [{ href: '/board/treasurer' }] });
    const all = bar ? hrefsOf(bar.sections.flatMap((section) => section.items)) : [];
    expect(all.filter((href) => href.startsWith('/board/') && !href.includes('-monitoring') && href !== '/board/aggregates')).toEqual(['/board/treasurer']);
  });

  it('opens Home on Board Hub for a board session with no seat', () => {
    expect(jobBarFor('board')?.sections[0]).toEqual({ label: 'Home', items: [{ href: '/board' }] });
  });

  it('counts the landing seat as held when no seat list is passed', () => {
    expect(jobBarFor('board', { boardSeat: 'secretary' })?.sections[0].items).toEqual([{ href: '/board/secretary' }]);
  });

  it('lands a member who holds two seats on their landing seat', () => {
    expect(jobBarFor('board', { boardSeat: 'secretary', boardSeats: ['at-large', 'secretary'] })?.sections[0].items)
      .toEqual([{ href: '/board/secretary' }]);
  });

  it('trusts the held seats over a stale landing seat: Home is Board Hub, never the lost seat', () => {
    const bar = jobBarFor('board', { boardSeat: 'treasurer', boardSeats: ['secretary'] });
    expect(bar?.sections[0].items).toEqual([{ href: '/board' }]);
    expect(hrefsOf(bar?.sections.flatMap((section) => section.items) ?? [])).not.toContain('/board/treasurer');
  });

  it('does not guess a landing seat from the seat list alone: Home is Board Hub', () => {
    expect(jobBarFor('board', { boardSeats: ['treasurer'] })?.sections[0].items).toEqual([{ href: '/board' }]);
  });

  it('gives the chair their own seat as Home', () => {
    expect(jobBarFor('board', { boardSeat: 'chair', boardSeats: ['chair'] })?.sections[0].items).toEqual([{ href: '/board/chair' }]);
  });
});

describe("the platform owner's bar", () => {
  it('has Gyms, the All Gyms Overview page (Overwatch: the Gyms section is not dropped)', () => {
    expect(jobBarFor('platform_owner')?.sections.find((section) => section.label === 'Gyms')?.items).toEqual([
      { href: '/admin/platform/overview' },
    ]);
  });
});

describe('what a person cannot open, their bar does not show', () => {
  afterEach(() => jest.restoreAllMocks());

  it('drops a page whose door the person is not given, and a section left with none', () => {
    const hidden = new Set(['/coach/class', '/coach/environment/intake-router']);
    jest.spyOn(buildingMap, 'visibleDoors').mockReturnValue(BUILDING.filter((door) => !hidden.has(door.href)));
    const bar = jobBarFor('coach');
    expect(bar?.sections.map((section) => section.label)).toEqual(['Class', 'Athletes', 'Plan', 'Safety']);
    expect(hrefsOf(bar?.sections.find((section) => section.label === 'Class')?.items ?? [])).toEqual([
      '/schedule', '/coach/test-day', '/coach/visualization',
    ]);
  });

  it('drops a More page the same way', () => {
    jest.spyOn(buildingMap, 'visibleDoors').mockReturnValue(BUILDING.filter((door) => door.href !== '/names'));
    expect(hrefsOf(jobBarFor('coach')?.more ?? [])).not.toContain('/names');
  });
});
