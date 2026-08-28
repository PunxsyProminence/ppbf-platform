/**
 * @jest-environment jsdom
 */

// The submit path reports to the athlete whether their session was kept.
// Telling someone some of their work saved -- and stamping a save time -- when
// the server accepted nothing is the one failure they cannot recover from,
// because the message tells them not to put it in again.
//
// The strings matched below are the athlete-facing ones and they are matched
// loosely on purpose: what is pinned is that the three outcomes stay three
// distinguishable messages, not the exact wording of any of them.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { FORMULA_UNITS, OBSERVATION_KINDS } from '@/src/server/pilot/formulas/types';
import SparringTelemetryPage from './page';

// This page gained a role gate it previously lacked (every sibling athlete
// route already had one; this was the one place a signed-out visitor could
// load the full form). RoleStandaloneView pulls in RoleSessionGate, which
// calls next/navigation's useRouter -- not mounted in this test's render
// tree -- so it's stubbed to a pass-through the same way
// progression-intelligence/page.test.tsx already does for the same reason.
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const SESSION_PATH = '/api/pilot/auth/session';

const submittedObservations: Array<Record<string, unknown>> = [];

function mockFetch(
  observationOk: (index: number) => boolean,
  // What the observations API answers with. Defaults to the empty object the
  // ordinary path sees; a test that drives the safety-review branch passes a
  // payload carrying safetyReview -- without this hook, no test could ever
  // make safetyReviewRaised true, and the safety branch sat unguarded (found
  // by mutation audit 2026-08-25: the whole branch could be deleted with the
  // suite green).
  observationPayload: (index: number) => Record<string, unknown> = () => ({}),
) {
  let index = 0;
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(SESSION_PATH)) {
      // `role` is what the real route sends (app/api/pilot/auth/session) and
      // what the page now reads to decide whether the person filling this in
      // IS the subject or has to name one. The stub omitted it while nothing
      // looked at it, which made every test here silently an athlete.
      return {
        ok: true,
        json: async () => ({ authenticated: true, role: 'athlete', account_id: 'acct-athlete-001', athlete_id: 'athlete-001' }),
      } as Response;
    }

    if (typeof init?.body === 'string') {
      submittedObservations.push(JSON.parse(init.body) as Record<string, unknown>);
    }

    const at = index++;
    return {
      ok: observationOk(at),
      json: async () => observationPayload(at),
    } as Response;
  });
}

async function renderAndSubmit(
  observationOk: (index: number) => boolean,
  observationPayload?: (index: number) => Record<string, unknown>,
) {
  submittedObservations.length = 0;
  global.fetch = mockFetch(observationOk, observationPayload) as unknown as typeof fetch;
  const { container } = render(<SparringTelemetryPage />);

  const submit = await screen.findByRole('button', { name: 'Log This Session' });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));

  fireEvent.submit(container.querySelector('form') as HTMLFormElement);
}

describe('sparring log submission status', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a submission the server rejected entirely is not reported as saved', async () => {
    await renderAndSubmit(() => false);

    await screen.findByText(/Nothing saved/);
    expect(screen.queryByText(/Some of it saved/)).toBeNull();
    // The stamp is the athlete's only evidence a record exists, so it must not
    // move when no record was created.
    expect(screen.getByText('Nothing logged yet')).toBeTruthy();
  });

  test('a submission the server partly accepted is reported as partial and stamped', async () => {
    await renderAndSubmit((index) => index > 0);

    await screen.findByText(/Some of it saved, some did not/);
    expect(screen.queryByText('Nothing logged yet')).toBeNull();
  });

  test('a fully accepted submission is reported as saved and stamped', async () => {
    await renderAndSubmit(() => true);

    await screen.findByText('Saved to your training record.');
    expect(screen.queryByText('Nothing logged yet')).toBeNull();
  });

  // Nothing reads ordinary sparring observations back out: the results
  // endpoint has no client caller, and no coach surface or SHADOW context
  // queries shadow_formula_observations. Until one exists, no athlete-facing
  // text on this page may tell a child a coach sees or reads what they
  // logged. The one legitimate exception is the safety-review branch ("your
  // coach has been asked to look at it"), which a flagged near miss really
  // does back -- and it renders only when the safety gate raised it, not on
  // an ordinary save.
  test('a raised safety review tells the athlete a coach has been asked to look', async () => {
    // The one coach claim this page is allowed to make, because it is backed:
    // missing clearance or contact-during-hold files a flagged near miss a
    // coach really receives. This drives the branch with a real payload --
    // the harness default of {} means no other test can reach it, so without
    // this pin the entire safety message was deletable with the suite green.
    await renderAndSubmit(() => true, (index) => (index === 0 ? { safetyReview: { raised: true } } : {}));

    const status = await screen.findByText(/your coach has been asked to look at it/);
    expect(status.textContent).toContain('no current medical clearance');
    expect(status.textContent).toContain('do not put it in again');
    // And it must not fall through to the ordinary wording.
    expect(screen.queryByText('Saved to your training record.')).toBeNull();
  });

  test('a safety-review lesson from the server is shown to the athlete verbatim', async () => {
    await renderAndSubmit(() => true, () => ({ safetyReview: { raised: true, lesson: 'Contact stays off until a coach clears it.' } }));

    const status = await screen.findByText(/your coach has been asked to look at it/);
    expect(status.textContent).toContain('Contact stays off until a coach clears it.');
  });

  test('an ordinary save claims no coach visibility anywhere on the page', async () => {
    await renderAndSubmit(() => true);

    await screen.findByText('Saved to your training record.');
    expect(screen.queryByText(/coach sees/i)).toBeNull();
    expect(screen.queryByText(/coach reads/i)).toBeNull();
    expect(screen.queryByText(/hand your coach/i)).toBeNull();
    expect(screen.queryByText(/coach should know/i)).toBeNull();
    expect(screen.queryByText(/coach may not see/i)).toBeNull();
  });

  // The rounds field is TOTAL session rounds. Sending it as 'contact_rounds'
  // for a contact level of 0 ('None') told the safety gate that a bag-work
  // session was six rounds of contact -- filing a contact-without-clearance
  // flag against an athlete who honestly reported that no contact occurred.
  test('a zero-contact session submits neither contact_level nor contact_rounds', async () => {
    global.fetch = mockFetch(() => true) as unknown as typeof fetch;
    submittedObservations.length = 0;
    const { container } = render(<SparringTelemetryPage />);

    const submit = await screen.findByRole('button', { name: 'Log This Session' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(screen.getByLabelText('How hard the contact was'), { target: { value: '0' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));
    const kinds = submittedObservations.map((observation) => observation.kind);
    expect(kinds).not.toContain('contact_level');
    expect(kinds).not.toContain('contact_rounds');
    // The non-contact observations still go through -- the session itself is
    // still a record worth keeping.
    expect(kinds).toContain('punch_attempted');
    expect(kinds).toContain('focus_achieved');
  });

  test('a contact session still submits the contact pair', async () => {
    await renderAndSubmit(() => true);

    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));
    const kinds = submittedObservations.map((observation) => observation.kind);
    expect(kinds).toContain('contact_level');
    expect(kinds).toContain('contact_rounds');
  });

  // Every field on this form is submitted as a typed observation, and the API
  // rejects an unknown kind or unit outright -- so a term the server does not
  // share is a whole field silently lost, not a degraded one.
  test('every observation submitted uses vocabulary the observations API accepts', async () => {
    global.fetch = mockFetch(() => true) as unknown as typeof fetch;
    submittedObservations.length = 0;
    const { container } = render(<SparringTelemetryPage />);

    const submit = await screen.findByRole('button', { name: 'Log This Session' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(screen.getByLabelText('Your weight (kg, if you want)'), { target: { value: '61.5' } });
    fireEvent.change(screen.getByLabelText('Notes on how it went'), { target: { value: 'Right wrist sore.' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));
    expect(submittedObservations.map((observation) => observation.kind)).toContain('recovery_notes');
    for (const observation of submittedObservations) {
      expect(OBSERVATION_KINDS).toContain(observation.kind);
      expect(FORMULA_UNITS).toContain(observation.unit);
      const notes = (observation.dimensions as { notes?: string } | undefined)?.notes;
      if (typeof notes === 'string') {
        expect(notes.length).toBeLessThanOrEqual(300);
      }
    }
  });
});


/*
 * THE COACH PATH, WHICH DID NOT WORK.
 * -----------------------------------
 *
 * The page has admitted 'coach' and 'admin' since it gained its role gate, the
 * observations route has accepted a coach submission for an authorized athlete
 * for just as long, and the page's own comment calls a coach logging on a
 * shared tablet "a real path, not a leftover". It was not one: the subject came
 * from payload.athlete_id, a coach's session carries none, so the submit button
 * was disabled forever with nothing on screen saying why.
 *
 * Reproduced before the fix (a coach session, button never enabled), which is
 * what these now hold shut. The server side is unchanged and is NOT what these
 * test: assertActorCanAccessAthlete was always correct, and the route tests in
 * app/api/pilot/coach/athletes cover which athletes reach the picker at all.
 * What is pinned here is that the page never composes an athlete id of its own.
 */
const COACH_ROSTER_PATH = '/api/pilot/coach/athletes';

interface StaffMocks {
  readonly role?: string;
  readonly rosterOk?: boolean;
  readonly roster?: Array<{ athlete_id: string; full_name: string }>;
}

function mockStaffFetch(options: StaffMocks = {}) {
  const roster = options.roster ?? [{ athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' }];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(SESSION_PATH)) {
      // Exactly what the real route sends a coach: authenticated, a role, and
      // athlete_id null, because a coach is not an athlete.
      return {
        ok: true,
        json: async () => ({
          authenticated: true,
          role: options.role ?? 'coach',
          account_id: 'acct-coach-a',
          athlete_id: null,
        }),
      } as Response;
    }
    if (url.includes(COACH_ROSTER_PATH)) {
      return {
        ok: options.rosterOk ?? true,
        json: async () => ({ ok: true, items: roster }),
      } as Response;
    }
    if (typeof init?.body === 'string') {
      submittedObservations.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

async function renderAsStaff(options: StaffMocks = {}) {
  submittedObservations.length = 0;
  const fetchMock = mockStaffFetch(options);
  global.fetch = fetchMock as unknown as typeof fetch;
  const view = render(<SparringTelemetryPage />);
  // The picker is the signal that the staff branch resolved.
  await screen.findByLabelText('Which athlete is this for');
  return { ...view, fetchMock };
}

describe('a coach logging a session for an athlete', () => {
  test('can open the log and is offered the athletes they are authorized for', async () => {
    await renderAsStaff({
      roster: [
        { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' },
        { athlete_id: 'ath-marcus', full_name: 'Marcus Webb' },
      ],
    });

    const picker = screen.getByLabelText('Which athlete is this for') as HTMLSelectElement;
    const options = Array.from(picker.options).map((option) => option.value).filter(Boolean);
    expect(options).toEqual(['ath-rosa', 'ath-marcus']);
  });

  test('the picker is populated from the access contract, not from the whole-gym roster', async () => {
    // /api/pilot/athletes/list answers a coach with EVERY athlete in the
    // organization (a display projection with field redaction). If this page
    // ever reads it for the picker, the coach is offered children the server
    // will refuse and the refusal arrives after the session is typed in.
    const { fetchMock } = await renderAsStaff();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes(COACH_ROSTER_PATH))).toBe(true);
    expect(urls.some((url) => url.includes('/api/pilot/athletes/list'))).toBe(false);
  });

  test('cannot submit until an athlete is chosen, and is told which is missing', async () => {
    const { container } = await renderAsStaff();

    const submit = screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toMatch(/Choose which athlete this session is for/i));
    // The old copy sent a coach who had simply not picked anybody to the login
    // screen to fix a dropdown.
    expect(screen.getByRole('status').textContent).not.toMatch(/not signed in/i);
    expect(submittedObservations).toHaveLength(0);
  });

  test('submits for the chosen athlete, and for no other', async () => {
    const { container } = await renderAsStaff({
      roster: [
        { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' },
        { athlete_id: 'ath-marcus', full_name: 'Marcus Webb' },
      ],
    });

    fireEvent.change(screen.getByLabelText('Which athlete is this for'), { target: { value: 'ath-marcus' } });
    const submit = screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));

    const subjects = new Set(submittedObservations.map((observation) => observation.athleteId));
    expect(subjects).toEqual(new Set(['ath-marcus']));
  });

  test('no athlete id the server did not offer can be submitted', async () => {
    // The control is a <select> over server-returned options, so there is no
    // free-text path for an arbitrary id. Setting a value that is not an
    // option leaves the selection empty rather than adopting it.
    const { container } = await renderAsStaff({ roster: [{ athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' }] });

    const picker = screen.getByLabelText('Which athlete is this for') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'ath-not-mine' } });

    expect(picker.value).not.toBe('ath-not-mine');
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toMatch(/Choose which athlete this session is for/i));
    expect(submittedObservations).toHaveLength(0);
  });

  test('no organization id is sent with the observation, ever', async () => {
    // Organization scope is resolved server-side from the session. A client
    // that offered one would be offering a scope to widen.
    const { container } = await renderAsStaff();

    fireEvent.change(screen.getByLabelText('Which athlete is this for'), { target: { value: 'ath-rosa' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(submittedObservations.length).toBeGreaterThan(0));

    for (const observation of submittedObservations) {
      expect(Object.keys(observation)).not.toContain('organizationId');
      expect(Object.keys(observation)).not.toContain('organization_id');
    }
  });

  test('a failed roster read is not rendered as "you have no athletes"', async () => {
    await renderAsStaff({ rosterOk: false });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/not the coach of record for any athlete/i)).toBeNull();
    expect((screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a coach with genuinely no assigned athletes is told that, distinctly', async () => {
    await renderAsStaff({ roster: [] });

    expect(screen.getByText(/not the coach of record for any athlete/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  test('the safety-review branch still reaches a coach, in the coach\'s own words', async () => {
    // Contact logged for an athlete with no current medical clearance raises a
    // review server-side. The record is kept deliberately; the person who
    // typed it must be told, whoever they are.
    submittedObservations.length = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(SESSION_PATH)) {
        return { ok: true, json: async () => ({ authenticated: true, role: 'coach', account_id: 'acct-coach-a', athlete_id: null }) } as Response;
      }
      if (url.includes(COACH_ROSTER_PATH)) {
        return { ok: true, json: async () => ({ ok: true, items: [{ athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' }] }) } as Response;
      }
      if (typeof init?.body === 'string') {
        submittedObservations.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return {
        ok: true,
        json: async () => ({ safetyReview: { raised: true, lesson: 'A current clearance is filed at the front desk.' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const { container } = render(<SparringTelemetryPage />);
    await screen.findByLabelText('Which athlete is this for');
    fireEvent.change(screen.getByLabelText('Which athlete is this for'), { target: { value: 'ath-rosa' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/no current medical clearance/i));
    expect(screen.getByRole('status').textContent).toMatch(/A current clearance is filed at the front desk\./);
  });

  test('a saved session is not described to a coach as their own record', async () => {
    const { container } = await renderAsStaff({ roster: [{ athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' }] });

    fireEvent.change(screen.getByLabelText('Which athlete is this for'), { target: { value: 'ath-rosa' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Log This Session' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Saved to Rosa Delgado's training record/i));
    expect(screen.getByRole('status').textContent).not.toMatch(/Saved to your training record/i);
  });

  test('an organization admin gets the same picker', async () => {
    // The role gate and the observations route both admit this role, and
    // /api/pilot/coach/athletes answers it with the organization's athletes.
    await renderAsStaff({ role: 'organization_admin' });

    expect(screen.getByLabelText('Which athlete is this for')).toBeTruthy();
  });

  test('an athlete still logs their own session, with no picker at all', async () => {
    global.fetch = mockFetch(() => true);
    render(<SparringTelemetryPage />);

    const submit = await screen.findByRole('button', { name: 'Log This Session' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText('Which athlete is this for')).toBeNull();
  });

  test('a session read that fails leaves the page inert rather than guessing a role', async () => {
    // Neither an athlete's own log nor a coach's picker: nothing is known
    // about who is holding the page, so nothing is offered.
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    render(<SparringTelemetryPage />);

    const submit = await screen.findByRole('button', { name: 'Log This Session' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Which athlete is this for')).toBeNull();
  });
});
