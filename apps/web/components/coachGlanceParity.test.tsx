/**
 * @jest-environment jsdom
 */

/**
 * THE GLANCE PARITY MATRIX.
 *
 * One source state, driven through BOTH layouts, asserting the same MEANING in
 * each. The coach board now renders two ways -- BOARD, one hand-built panel,
 * and ROOM, the same facts as gym objects -- and the danger in that is not that
 * one of them looks wrong. It is that they quietly answer the same question
 * differently.
 *
 * That is not hypothetical here. This repository already ships two instruments
 * over one escalation queue that disagree by construction: SafetyAttentionBadge
 * renders nothing unless critical+high > 0, while the board counts all four
 * severities. Nobody wrote that on purpose. It is what happens when a fact has
 * two owners, and a layout toggle is the fastest way to make nine more.
 *
 * WHAT THIS SUITE IS HONESTLY WORTH TODAY, stated plainly so nobody reads more
 * into a green run than it earns:
 *
 * ROOM currently keeps every record the board shows, stacked under its glance
 * layer, because the clipboards are not doors yet and hiding an open safety
 * escalation behind an untappable number would be worse than the column it
 * replaces. So several assertions below are satisfied by those records rather
 * than by the room's own instruments. They pass trivially.
 *
 * They are still worth having. They are a ratchet: the moment the records come
 * out from under the glance layer -- which is the plan -- any fact the room
 * does not carry in its own right will fail here instead of going silently
 * missing on a tablet in a gym. A test that is trivially true today and
 * load-bearing next week is not a weak test; it is an early one.
 *
 * Where an assertion is NOT trivial -- where it reads the room's own clock,
 * pegs or clipboards -- it says so.
 *
 * Per the designer's ruling, this deliberately does NOT re-run the whole
 * honesty suite through both layouts. Most of that suite tests records and
 * actions only one layout renders, and running them twice would buy noise.
 * This covers the facts the two layouts genuinely share.
 */

import { act, fireEvent, screen } from '@testing-library/react';

import {
  jsonResponse,
  renderWorkspace,
  type RouteResponses,
} from './coachWorkspaceTestHarness';

type LayoutId = 'board' | 'room';
const LAYOUTS: readonly LayoutId[] = ['board', 'room'];

/**
 * Render the workspace and put it in the requested layout.
 *
 * ROOM is reached by PRESSING THE TOGGLE, not by seeding storage. Forcing the
 * preference would test the renderer and leave the control untested, and the
 * control is the only way a coach will ever get there.
 */
async function renderInLayout(layout: LayoutId, routes: RouteResponses = {}): Promise<void> {
  await renderWorkspace(routes);
  if (layout === 'room') {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Room' }));
    });
  }
  // The toggle really is in the state we asked for. Without this, a renamed or
  // broken control would make every ROOM case silently re-test BOARD.
  const pressed = screen
    .getAllByRole('button', { pressed: true })
    .map((el) => el.textContent?.trim());
  expect(pressed).toContain(layout === 'room' ? 'Room' : 'Board');
}

function liveRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run_1',
    script_id: 'scr_1',
    script_version: 3,
    activity_id: null,
    delivered_by_account_id: 'acct_coach_1',
    delivered_on: '2026-08-28',
    athletes_present: 11,
    run_state: 'in_progress',
    started_at: '2026-08-28T22:00:00.000Z',
    ended_at: null,
    current_block_id: 'blk_2',
    paused_at: null,
    paused_seconds: 0,
    elapsed_seconds: 1530,
    is_paused: false,
    ...overrides,
  };
}

const roster = () => jsonResponse({
  items: [
    { athlete_id: 'ath_1', full_name: 'Jordan P.' },
    { athlete_id: 'ath_2', full_name: 'Sam R.' },
  ],
});

const escalation = (overrides: Record<string, unknown> = {}) => ({
  escalation_id: 'esc_1',
  athlete_id: 'ath_1',
  source_type: 'pain_report',
  severity: 'high',
  reason: 'Pain score 8 reported after sparring round.',
  status: 'open',
  created_at: '2026-08-14T18:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  jest.restoreAllMocks();
  try { globalThis.localStorage?.clear(); } catch { /* storage may be unavailable */ }
});

describe.each(LAYOUTS)('%s layout tells the same truth', (layout) => {
  /* ---- SESSION ---------------------------------------------------------- */

  test('a session read that failed is never rendered as "no session"', async () => {
    /* The property, and it is not cosmetic: /coach/session-scripts disables its
       start control on exactly this signal, so a coach cannot open a second
       delivery over a live one. A layout that rendered UNKNOWN as "nothing is
       running" would be an invitation to do precisely that.

       NOT TRIVIAL in ROOM: the board's LED is deliberately unmounted there, so
       this can only be satisfied by the room's own clock face. */
    await renderInLayout(layout, {
      liveRun: () => jsonResponse({}, { ok: false, status: 500 }),
    });

    expect(screen.getByText(/could not be checked/i)).toBeTruthy();
    expect(screen.queryByText(/No session in progress/i)).toBeNull();
  });

  test('a running session shows the same elapsed time in both layouts', async () => {
    /* One number through one function. 1530 seconds is 25m 30s in both, or the
       two layouts are rounding the server's clock differently -- which is the
       small, plausible divergence this whole architecture exists to prevent.

       NOT TRIVIAL in ROOM: the LED is unmounted; this is the clock. */
    await renderInLayout(layout, {
      liveRun: () => jsonResponse({ ok: true, run: liveRun() }),
    });

    expect(screen.getByText('25m 30s')).toBeTruthy();
  });

  test('a paused session says so rather than looking like a running one', async () => {
    await renderInLayout(layout, {
      liveRun: () => jsonResponse({ ok: true, run: liveRun({ is_paused: true }) }),
    });

    expect(screen.getByText(/paused/i)).toBeTruthy();
  });

  /* ---- ATTENDANCE ------------------------------------------------------- */

  test('a register that could not be read never renders as an empty gym', async () => {
    /* The false zero, in the place it does most damage. A failed read moves
       every athlete to Unavailable; a layout that tallied that state would show
       0 present / 0 absent / 0 excused in the same typography it uses for a
       real register.

       NOT TRIVIAL in ROOM: the peg board asks attendanceGlance's `readable`
       flag FIRST and renders a card instead of four bare pegs. */
    await renderInLayout(layout, {
      athletesList: roster,
      attendanceToday: () => jsonResponse({}, { ok: false, status: 500 }),
    });

    expect(screen.getAllByText(/register unavailable/i).length).toBeGreaterThan(0);
  });

  /* ---- READINESS -------------------------------------------------------- */

  test('a readiness feed that failed says so, under the same headline', async () => {
    /* Both layouts say "No signal" for an empty board AND a dead feed -- that
       collapse is a recorded ruling and is not touched here. What both must
       also do is say WHICH, because one is somebody to chase and the other is a
       read to retry. */
    await renderInLayout(layout, {
      athletesList: roster,
      readinessBoard: () => jsonResponse({}, { ok: false, status: 500 }),
    });

    expect(screen.getAllByText(/No signal/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/could not be read/i).length).toBeGreaterThan(0);
  });

  test('an empty readiness board does not claim it could not be read', async () => {
    // The other direction. A failure line printed on every empty board is noise
    // within a week, and a coach stops reading it on the day it is true.
    await renderInLayout(layout, { athletesList: roster });

    expect(screen.getAllByText(/No signal/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  test('a flagged athlete is reported as flagged, in both layouts', async () => {
    /* THE CASE THIS SUITE DID NOT HAVE, and the reason it matters more than
       the two above it.

       Every readiness assertion here tested a kind of NOTHING -- a feed that
       failed, and a board that came back empty. Both are satisfied by a
       renderer that shows nothing at all, which is exactly what ROOM did: its
       clipboard rendered `readiness.unvalidated` and nothing else, so an
       athlete carrying a RED band arrived as the number 0 under the words
       "Nothing recorded today". The board said 1 RED. Sixteen parity tests
       passed over the top of it, because not one of them ever put a band on
       the feed.

       A validated reading is needed to produce a band at all: the workspace
       refuses to promote a row whose method nobody established, so the
       provenance fields below are load-bearing, not decoration. */
    await renderInLayout(layout, {
      athletesList: roster,
      readinessBoard: () => jsonResponse({
        items: [{
          athlete_id: 'ath_1',
          status: 'RED',
          score: 31,
          method: 'HRV_RMSSD',
          reliability_status: 'ESTABLISHED',
          validity_status: 'ESTABLISHED',
        }],
      }),
    });

    // The flag reaches the coach.
    expect(screen.getAllByText(/1 RED/).length).toBeGreaterThan(0);

    /* And is not contradicted in the same breath. These are the two sentences
       a coach would have read on the room's clipboard while an athlete was
       flagged RED, and either one alone is enough to send them back to the
       floor. */
    expect(screen.queryByText(/Nothing recorded today/i)).toBeNull();
    expect(screen.queryByText(/No signal/)).toBeNull();
  });

  /* ---- SHADOW ----------------------------------------------------------- */

  test('a SHADOW queue that could not be read is never rendered as a count', async () => {
    await renderInLayout(layout, {
      reviewProjection: () => jsonResponse({}, { ok: false, status: 503 }),
    });

    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/0 pending/i)).toBeNull();
  });

  test('a SHADOW queue read and genuinely empty says zero out loud', async () => {
    // The good news a coach came for, which used to be silence.
    await renderInLayout(layout, { reviewProjection: () => jsonResponse({ queue: [], total: 0 }) });

    expect(screen.getAllByText(/0 pending/i).length).toBeGreaterThan(0);
  });

  /* ---- ESCALATIONS ------------------------------------------------------ */

  test('an open escalation announces itself, in either layout', async () => {
    /* REACHABLE IS NOT THE SAME AS ANNOUNCED, and the test below this one only
       covers reachable.

       BOARD puts the records in an aria-live="polite" section and says why
       beside it: an alarm arriving while the coach is reading something else
       has to announce itself. ROOM retires that section -- rightly, one owner
       per safeguarding surface -- and the announcement left with it. A coach
       using a screen reader in ROOM got a digit changing behind a shut door,
       silently.

       This asserts the PROPERTY, not either layout's mechanism: somewhere in
       this document there is a live region that says an escalation is open.
       BOARD satisfies it with the records section it already had, ROOM with a
       status line of its own. Neither is named here, so either may be rebuilt
       without this test having to be edited to keep meaning what it says. */
    await renderInLayout(layout, {
      athletesList: roster,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
    });

    const announced = [...document.querySelectorAll(
      '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"]',
    )].filter((el) => /escalation/i.test(el.textContent ?? ''));

    expect(announced.length).toBeGreaterThan(0);
  });

  test('an open escalation reaches the coach in either layout', async () => {
    /* THE RATCHET FIRED, AND THIS IS THE UPDATE IT ASKED FOR.

       This was written when ROOM still stacked the board's records under its
       glance layer, and it said so: trivially satisfied today, load-bearing the
       moment the records move behind a door. They have. The attention clipboard
       is now a door and the escalation block is retired from ROOM, so this test
       went red -- which is the whole reason it existed.

       What it holds now is stronger than what it held then: not "the record is
       somewhere on the page", but "the record is REACHABLE", by the route a
       coach actually has. A layout where the door stops opening fails here. */
    await renderInLayout(layout, {
      athletesList: roster,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
    });

    if (layout === 'room') {
      expect(screen.queryByText(/Pain score 8 reported after sparring round/)).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open safety escalation records' }));
      });
    }

    expect(screen.getByText(/Pain score 8 reported after sparring round/)).toBeTruthy();
  });

});

/**
 * THE INJURY FLAG, AND WHY IT IS NOT IN THE MATRIX ABOVE.
 *
 * The designer asked specifically that an athlete carrying "Injury flag active"
 * stay identifiable in both layouts. It cannot be tested, because no athlete
 * can carry it.
 *
 * CoachWorkspace sets `injuryFlag: null` at the one place the roster is built
 * (loadAthletes), and that is the only assignment in the file. The badge is
 * gated on the value being truthy, so it is unreachable. This is deliberate,
 * not a bug: the loader's own comment says "Readiness and injury flag have no
 * backend source yet -- do not fabricate them", and an earlier version that DID
 * fabricate them attached invented injury status to real children's names.
 *
 * So the honest parity assertion is the one below. It pins the current truth --
 * the coach board makes no claim about injury status because it has nothing to
 * claim from -- and it is written to FAIL the day a real feed appears, which is
 * exactly when the parity question becomes answerable and somebody needs to go
 * and answer it for both layouts.
 */
describe('the injury flag', () => {
  test.each(LAYOUTS)('%s: no athlete can carry one, so neither layout claims to know', async (layout) => {
    await renderInLayout(layout, {
      // Sent the way a feed would send it, if a feed existed.
      athletesList: () => jsonResponse({
        items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.', injury_flag: true }],
      }),
    });

    /* If this starts failing, a real injury feed has been wired. Good -- and
       the parity matrix above now needs a case for it, in BOTH layouts, before
       this line is simply deleted. */
    expect(screen.queryByText(/injury flag active/i)).toBeNull();
  });
});

/**
 * What only the ROOM carries. These are not parity assertions -- they are the
 * room's own instruments, and nothing in the board can satisfy them.
 */
describe('the room carries the facts in its own objects', () => {
  test('the peg board states all four marks, including unmarked', async () => {
    /* UNMARKED is the one that matters. It is not bad news and it is not a
       rounding error -- before the register is taken it is everyone -- and it
       gets a column of its own rather than being folded into absent. */
    await renderInLayout('room', { athletesList: roster });

    for (const mark of ['Present', 'Absent', 'Excused', 'Unmarked']) {
      expect(screen.getAllByText(mark).length).toBeGreaterThan(0);
    }
  });

  test('the attention clipboard carries the severity composition, not just a count', async () => {
    // The composition is what tells a coach whether "3 open" is three sore
    // shoulders or one child in trouble.
    await renderInLayout('room', {
      athletesList: roster,
      escalationsGet: () => jsonResponse({
        ok: true,
        escalations: [
          escalation({ severity: 'critical' }),
          escalation({ escalation_id: 'esc_2', severity: 'high' }),
          escalation({ escalation_id: 'esc_3', severity: 'high' }),
        ],
      }),
    });

    /* Read off the clipboard itself, not off the page. The escalation records
       below say "critical" and "high" too, so a page-wide text query here would
       pass whether or not the clipboard carried anything -- the exact kind of
       assertion that looks like coverage and is not. */
    const clip = document.querySelector('.rm-clip');
    expect(clip?.textContent).toMatch(/1\s*critical/i);
    expect(clip?.textContent).toMatch(/2\s*high/i);
  });

  test('an acknowledged escalation stops being counted on the clipboard too', async () => {
    /* The bug fixed on the board, asserted on the room's own instrument, so the
       fix cannot hold in one layout and rot in the other -- which is exactly
       how the board and SafetyAttentionBadge drifted apart in the first place. */
    await renderInLayout('room', {
      athletesList: roster,
      escalationsGet: () => jsonResponse({
        ok: true,
        escalations: [
          escalation(),
          escalation({ escalation_id: 'esc_2', status: 'acknowledged' }),
        ],
      }),
    });

    // One open, one acknowledged. The clipboard's VALUE is the open count, read
    // from the value element rather than from the concatenated card text --
    // "Need attention" + "1" + "1 high" runs together into a string where a
    // regex for the count is really a regex for a coincidence.
    const value = document.querySelector('.rm-clip .rm-clip-v');
    expect(value?.textContent?.trim()).toBe('1');
  });

  test('the attention clipboard is closed until asked, then holds the real records', async () => {
    /* The second door. The records it opens are not a copy of the board's --
       they are the same JSX, placed here instead, and the escalation block is
       retired from ROOM because this door fully replaces what it owned. A copy
       would be how the board and SafetyAttentionBadge came to disagree. */
    await renderInLayout('room', {
      athletesList: roster,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
    });

    expect(screen.queryByText(/Pain score 8 reported after sparring round/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open safety escalation records' }));
    });

    // The record, and the action that goes with it. A door onto records a coach
    // cannot act on would be a worse version of the stack it replaced.
    expect(screen.getByText(/Pain score 8 reported after sparring round/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Acknowledge safety escalation for / })).toBeTruthy();
  });

  test('the clipboard still opens when the read FAILED, because that is when it matters', async () => {
    /* A door that closes itself on failure strands the coach on a summary
       saying "Unread" with nowhere to go. The panel behind it carries the
       error, the retry, and the warning that escalations may exist which are
       not shown -- none of which fits on a clipboard. */
    await renderInLayout('room', {
      athletesList: roster,
      escalationsGet: () => jsonResponse({}, { ok: false, status: 500 }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open safety escalation records' }));
    });

    /* Scoped to the panel deliberately. The warning appears TWICE when the
       panel is open -- once on the clipboard, once in the records -- and that
       is correct rather than sloppy: a coach who only glances must see it, and
       so must a coach who opens. A page-wide query would pass on either copy
       alone, so it would not prove the panel carries it. */
    const panel = document.querySelector('.rd');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toMatch(/Read unavailable/i);
    expect(panel?.textContent).toMatch(/may exist that are not shown/i);
    expect(screen.getByRole('button', { name: 'Refresh safety escalations' })).toBeTruthy();
  });

  test('the escalation block is retired from the room, not duplicated under its own door', async () => {
    /* The designer's rule: once a door gives complete access to everything a
       legacy block owns, that block retires in the same slice. Leaving it below
       keeps exactly the clutter the room exists to remove, and makes the record
       answerable in two places.

       Counted rather than asserted absent, because "not on the page" would also
       pass if the door were broken and the record unreachable. */
    await renderInLayout('room', {
      athletesList: roster,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open safety escalation records' }));
    });

    expect(screen.getAllByText(/Pain score 8 reported after sparring round/)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Acknowledge safety escalation for / })).toHaveLength(1);
  });

  test('the peg board opens the register, and it holds the same population it counted', async () => {
    /* THE FIRST GLANCE -> OPEN -> WORK DOOR, and the property that makes it
       worth anything: the names behind the number are the population the number
       was taken from. A coach who taps "1 present, 2 unmarked" and finds four
       names, or two, has been told two different things by one instrument.

       Counted off the pegs and off the register rows in the same assertion, so
       this fails if either side drifts rather than only if the door breaks. */
    await renderInLayout('room', {
      athletesList: () => jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'Jordan P.' },
          { athlete_id: 'ath_2', full_name: 'Sam R.' },
          { athlete_id: 'ath_3', full_name: 'Rosa D.' },
        ],
      }),
      attendanceToday: () => jsonResponse({
        covered: ['ath_1', 'ath_2', 'ath_3'],
        marks: [{ athlete_id: 'ath_1', status: 'present' }],
      }),
    });

    const pegTotal = [...document.querySelectorAll('.rm-peg-n')]
      .reduce((sum, el) => sum + Number(el.textContent ?? 0), 0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Open today's attendance register" }));
    });

    const rows = document.querySelectorAll('.rg-row');
    expect(rows.length).toBe(pegTotal);
    expect(rows.length).toBe(3);
  });
});

describe('the layout choice is remembered', () => {
  const KEY = 'ppbf:coach-layout:v1:acct_coach_1';

  test('a choice made before the session read lands is still written down', async () => {
    /* THE WINDOW THIS COVERS IS THE ORDINARY ONE, not an exotic one.

       The account id arrives from an asynchronous session read, and the
       preference is keyed by account so one coach's choice cannot leak onto
       the next coach who picks up the tablet. Both of those are right. Together
       they meant that a coach who reached for the toggle before that read
       returned had their write DECLINED -- correctly, there was no account to
       write against -- and then never asked again. The layout held for that
       visit and was forgotten by the next one.

       Toggling immediately is not unusual behaviour on a gym tablet on slow
       wifi. It is the normal way to use a two-position control. So the visible
       symptom was "this setting does not work", intermittently, in exactly the
       conditions the gym actually has. */
    let releaseSession: (value: Response) => void = () => {};
    const heldSession = new Promise<Response>((resolve) => { releaseSession = resolve; });

    await renderWorkspace({ session: () => heldSession });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Room' }));
    });

    /* Nothing is stored yet, and that is the correct intermediate state --
       storing under the anonymous key is the shared-tablet bleed the key
       scheme exists to prevent. This asserts the refusal still happens, so a
       "fix" that simply wrote it anyway would fail here. */
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();

    await act(async () => {
      releaseSession(jsonResponse({ authenticated: true, account_id: 'acct_coach_1' }));
      await heldSession;
    });

    expect(globalThis.localStorage.getItem(KEY)).toBe('room');

    // And the coach is still looking at what they chose -- the arriving
    // session must not scroll them back to the default on its way past.
    expect(
      screen.getAllByRole('button', { pressed: true }).map((el) => el.textContent?.trim()),
    ).toContain('Room');
  });

  test('the ordinary path still writes exactly once, from the handler', async () => {
    // The retry above is dormant unless a write was refused. If it were not,
    // every layout change would write twice and the effect would be doing the
    // handler's job -- so this pins which one is load-bearing.
    await renderWorkspace();
    const setItem = jest.spyOn(globalThis.Storage.prototype, 'setItem');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Room' }));
    });

    const layoutWrites = setItem.mock.calls.filter(([key]) => String(key) === KEY);
    expect(layoutWrites).toEqual([[KEY, 'room']]);
  });
});
