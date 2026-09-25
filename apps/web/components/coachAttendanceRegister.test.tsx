/**
 * @jest-environment jsdom
 */

/**
 * THE OPEN REGISTER: the first glance -> open -> work journey in the room.
 *
 * The peg board says how the room is. This says who exactly. The properties
 * worth holding are not that it renders a list -- they are that the names
 * behind the count are THE SAME POPULATION the count was taken from, that the
 * three kinds of not-knowing survive the journey from glance to detail, and
 * that a register nobody could read never looks like a register nobody is on.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachAttendanceRegister, {
  type CoachAttendanceRegisterProps,
} from './CoachAttendanceRegister';
import {
  jsonResponse,
  renderWorkspace,
  type RouteResponses,
} from './coachWorkspaceTestHarness';

/** Render, switch to ROOM, and open the register through the peg board --
 *  the way a coach reaches it. */
async function openRegister(routes: RouteResponses = {}): Promise<void> {
  await renderWorkspace(routes);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Room' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "Open today's attendance register" }));
  });
}

const fourAthletes = () => jsonResponse({
  items: [
    { athlete_id: 'ath_1', full_name: 'Jordan P.' },
    { athlete_id: 'ath_2', full_name: 'Sam R.' },
    { athlete_id: 'ath_3', full_name: 'Rosa D.' },
    { athlete_id: 'ath_4', full_name: 'Chris O.' },
  ],
});

/** Three covered athletes, one of them marked; the fourth is not covered at
 *  all, which is a different kind of not-knowing from the unmarked two. */
const mixedRegister = () => jsonResponse({
  covered: ['ath_1', 'ath_2', 'ath_3'],
  marks: [{ athlete_id: 'ath_1', status: 'present' }],
});

afterEach(() => {
  jest.restoreAllMocks();
  try { globalThis.localStorage?.clear(); } catch { /* storage may be unavailable */ }
});

describe('the peg board opens the register', () => {
  test('the register is closed until the coach asks for it', async () => {
    /* A detail surface that arrives already open is the column again. The
       whole point of the glance layer is that the records are one deliberate
       step away, not stacked underneath by default. */
    await renderWorkspace({ athletesList: fourAthletes });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Room' }));
    });

    expect(screen.queryByRole('region', { name: "Today's attendance register" })).toBeNull();
    expect(screen.getByRole('button', { name: "Open today's attendance register" })).toBeTruthy();
  });

  test('opening it shows every athlete the count was taken from', async () => {
    /* THE PROPERTY THAT MATTERS MOST. The gauge and the surface behind it read
       one derivation, so the names cannot be a different population from the
       number. A coach who taps "3 present" and finds four names has been told
       two things. */
    await openRegister({ athletesList: fourAthletes, attendanceToday: mixedRegister });

    for (const name of ['Jordan P.', 'Sam R.', 'Rosa D.', 'Chris O.']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  test('it closes again, leaving the glance behind it', async () => {
    await openRegister({ athletesList: fourAthletes, attendanceToday: mixedRegister });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });

    expect(screen.queryByRole('region', { name: "Today's attendance register" })).toBeNull();
    expect(screen.getByRole('button', { name: "Open today's attendance register" })).toBeTruthy();
  });
});

describe('the register keeps the three kinds of not-knowing apart', () => {
  test('a mark, an unmarked athlete and an uncovered one read differently', async () => {
    /* These are not shades of the same thing.
         Present        a mark that exists on record
         No mark yet    we looked; nobody has ticked them off
         Not your athlete  nobody asked -- they are outside this coach's register
       Collapsing the last two would tell a coach that somebody they cannot see
       is simply unmarked, which invites them to go and mark them. */
    await openRegister({ athletesList: fourAthletes, attendanceToday: mixedRegister });

    const region = screen.getByRole('region', { name: "Today's attendance register" });
    expect(region.textContent).toMatch(/Present/);
    expect(region.textContent).toMatch(/No mark yet/);
    expect(region.textContent).toMatch(/Not your athlete/);
  });

  test('an unmarked athlete is never called absent', async () => {
    // The register may simply not have been taken yet. A child who did not
    // train and a child nobody has ticked off look identical from here.
    await openRegister({
      athletesList: fourAthletes,
      attendanceToday: () => jsonResponse({ covered: ['ath_1', 'ath_2', 'ath_3', 'ath_4'], marks: [] }),
    });

    const region = screen.getByRole('region', { name: "Today's attendance register" });
    expect(region.textContent).toMatch(/No mark yet/);
    expect(region.textContent).not.toMatch(/\bAbsent\b/);
  });
});

describe('a register that could not be read', () => {
  /* WHY THESE RENDER THE COMPONENT DIRECTLY.

     A first version drove them through the peg board and failed, which was the
     test being wrong and the app being right: when the read fails, the glance
     layer REPLACES the peg board with a card, so there is no door to open. That
     is correct. A register that says "unavailable" four times adds nothing to a
     card that already says it once.

     The branch is still reachable, just not by that click: the coach opens the
     register on a good read, the roster refreshes underneath them, and THAT
     read fails. Everything on screen must then stop claiming to be today's
     marks. Rendering the component directly tests that contract without
     pretending the state is one click away. */
  function showRegister(props: Partial<CoachAttendanceRegisterProps> = {}) {
    render(
      <CoachAttendanceRegister
        athletes={[
          { id: 'ath_1', name: 'Jordan P.', attendance: 'Present' },
          { id: 'ath_2', name: 'Sam R.', attendance: 'Unknown' },
        ]}
        loading={false}
        readable={false}
        onClose={() => {}}
        {...props}
      />,
    );
  }

  test('says so instead of listing nobody', async () => {
    /* THE FALSE ZERO, one layer deeper than the peg board. An empty list here
       reads as a gym nobody came to, in the same typography a real register
       uses. The failed read gets a card and the list does not render at all. */
    showRegister();

    const region = screen.getByRole('region', { name: "Today's attendance register" });
    expect(region.textContent).toMatch(/Register unavailable/);
    expect(region.textContent).toMatch(/not read this as an empty gym/i);
  });

  test('does not keep showing the marks it can no longer vouch for', async () => {
    /* The rows are still in props -- the component is handed the same roster it
       had a moment ago. It must not draw them. A name beside "Present" on a
       screen whose read just failed is yesterday's answer wearing today's
       clothes. */
    showRegister();

    const region = screen.getByRole('region', { name: "Today's attendance register" });
    expect(region.textContent).not.toMatch(/Jordan P\./);
    expect(region.textContent).not.toMatch(/No mark yet/);
  });

  test('still offers the way to go and make a mark', async () => {
    // The read failing is exactly when a coach most wants the other door.
    showRegister();

    expect(screen.getByRole('link', { name: /Mark class attendance in Schedule/i })).toBeTruthy();
  });
});

describe('the door out', () => {
  test('points at the place a mark is actually made', async () => {
    /* The register is read-only for a reason that is NOT "attendance cannot be
       written" -- it can, through the class register on Schedule. The reason is
       a grain mismatch: this screen shows athlete-DAY attendance reconciled
       across sources, while the write takes athlete-CLASS attendance. An
       athlete can sit in two classes in a day, so a Present control here would
       have to guess which class record it was editing.

       So the surface offers a door rather than a control, and rather than a
       sentence explaining the architecture -- which would be wallpaper inside a
       week. */
    await openRegister({ athletesList: fourAthletes, attendanceToday: mixedRegister });

    const door = screen.getByRole('link', { name: /Mark class attendance in Schedule/i });
    expect(door.getAttribute('href')).toBe('/schedule');
  });

  test('offers no control that looks like it marks the register', async () => {
    // A disabled-looking Present button would be worse than no button: a coach
    // would press it and conclude the app is broken rather than that this is
    // the wrong screen for it.
    await openRegister({ athletesList: fourAthletes, attendanceToday: mixedRegister });

    const region = screen.getByRole('region', { name: "Today's attendance register" });
    const buttons = Array.from(region.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Close']);
  });
});
