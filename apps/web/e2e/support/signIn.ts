import type { Page, Route } from '@playwright/test';

/* The shared door for every signed-in journey in this suite.
   ------------------------------------------------------------------------

   WHY THE API IS STUBBED AND THE BROWSER IS NOT. This repository already
   proves the two layers underneath a journey and proves them well: 105 `.pg`
   suites run real SQL against embedded Postgres, and ~160 route test files
   pin the API contracts. What no test touches is the layer above them -- a
   real person, in a real browser, going from a sign-in screen to the thing
   they came to do. These specs own that layer and only that layer, so the
   API is held still at the network boundary (`page.route`) and everything
   above it -- routing, the session gate, hydration, rendering, focus, colour
   -- is the genuine article.

   HOW A PAGE DECIDES IT IS SIGNED IN. There are two halves and both matter
   here:

     * the server half -- an HttpOnly `ppbf_pilot_session` cookie resolved
       against pilot.session_tokens (src/server/pilot/auth.ts). Pages using
       `requirePageRole` check this during render.
     * the client half -- RoleSessionGate POSTs `/api/pilot/auth/session` on
       mount and believes the answer (components/RoleSessionGate.tsx). The
       role cache in components/roleSession.ts is in-module memory, not
       localStorage, so there is nothing to pre-seed with addInitScript: the
       gate always asks the network, which is exactly the seam this helper
       occupies.

   That split is the reason this helper is stated in terms of client-gated
   surfaces. A route guarded by `requirePageRole` needs a session row in a
   database this sandbox does not have, and stubbing at the browser cannot
   reach a check that runs inside the Next server. See the note on
   `SERVER_GUARDED_ROUTES` below.

   POST, not GET, for the session route: /api/pilot/auth/session exports only
   POST, and a GET 405s. The route matcher here ignores the method on purpose
   so that a regression back to GET shows up as a real failure in the app
   rather than as a helper that quietly answers both. */

export type JourneyRole =
  | 'coach'
  | 'athlete'
  | 'parent'
  | 'board'
  | 'staff'
  | 'volunteer'
  | 'organization_admin'
  | 'platform_owner';

export type AuthProvider = 'microsoft' | 'ppbf_local';

export interface PilotSessionStub {
  readonly role: JourneyRole;
  /** Athletes are the only role admitted on a PIN; everyone else is federated.
      Defaults to the provider that role actually uses in production. */
  readonly authProvider?: AuthProvider;
  /** A gym-issued starting PIN that has never been changed. The app sends this
      state to /change-pin rather than to a workspace. */
  readonly mustChangePin?: boolean;
  readonly boardSeat?: string;
  /** The athlete this session IS. Athlete surfaces read athlete_id straight
      off the session response rather than asking a roster route -- an athlete
      is only ever allowed to be themselves -- so a stub without it renders
      "Unable to resolve athlete session" on a session the gate accepted. */
  readonly athleteId?: string;
}

/** The JSON body an endpoint answers with.

    Stated as an object/array/null union rather than `unknown` on purpose:
    `unknown | Fn` collapses straight back to `unknown`, which silently
    destroys the contextual typing of the handler form below -- every `(url,
    route) =>` stub becomes an implicit-any pair under `noImplicitAny`. */
export type PilotApiBody = Record<string, unknown> | readonly unknown[] | null;

/** A stub that inspects the request before answering -- to read an
    `athlete_id` off the query string, to branch on GET vs POST, or to record
    what the browser sent. */
export type PilotApiHandler = (url: URL, route: Route) => PilotApiBody;

/** Keyed by pathname; query strings are ignored when matching. */
export type PilotApiStubs = Record<string, PilotApiBody | PilotApiHandler>;

export const SESSION_ROUTE = '/api/pilot/auth/session';
export const LOGIN_ROUTE = '/api/pilot/auth/login';

/** Where each role's own workspace is, per src/shared/pilotRoleRouting.ts.
    Restated rather than imported: a journey test should assert where a person
    expects to end up, and importing the app's own answer would make the
    assertion agree with the code by construction. */
export const ROLE_DESTINATION: Record<string, string> = {
  coach: '/coach/environment/intake-router',
  athlete: '/athlete/dashboard',
  parent: '/parent/dashboard',
  board: '/board',
};

/* Routes whose role check runs on the SERVER (`requirePageRole`), so they
   resolve the session cookie against Postgres before a single byte of HTML is
   sent. With no database in this environment they answer 307 -> /login for
   every visitor, stub or not. They are listed rather than merely avoided so
   that the reason a journey lands where it lands is written down, and so a
   future run with a database can point these specs at them directly. */
export const SERVER_GUARDED_ROUTES = [
  '/athlete/dashboard',
  '/guardian/dashboard',
  '/coach/review-queue',
  '/coach/operations',
  '/board/dashboard',
  '/director/dashboard',
] as const;

function defaultAuthProvider(role: JourneyRole): AuthProvider {
  // credentialPolicy.usesPin: athletes, and only athletes, hold a PIN.
  return role === 'athlete' ? 'ppbf_local' : 'microsoft';
}

/** The body /api/pilot/auth/session returns for a live session, in the shape
    resolveAuthoritativeRoleSession reads (components/roleSession.ts). */
export function sessionPayload(session: PilotSessionStub) {
  return {
    authenticated: true,
    role: session.role,
    auth_provider: session.authProvider ?? defaultAuthProvider(session.role),
    must_change_pin: session.mustChangePin ?? false,
    ...(session.boardSeat ? { board_seat: session.boardSeat } : {}),
    ...(session.athleteId ? { athlete_id: session.athleteId } : {}),
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

export interface InstallPilotApiOptions {
  /** null means "nobody is signed in" -- the session route answers 401 and
      every gate bounces to /login, which is the correct negative case. */
  readonly session: PilotSessionStub | null;
  readonly routes?: PilotApiStubs;
  /** Every pilot path the page asked for that had no explicit stub. A journey
      can read this to see what a surface actually reaches for. */
  readonly unstubbed?: string[];
}

/**
 * Holds the whole pilot API still for one page.
 *
 * A single `page.route` handler dispatches by pathname rather than one
 * handler per endpoint, because Playwright matches routes in reverse
 * registration order and a suite that registers ten overlapping globs
 * eventually depends on that order without saying so. One handler, one
 * lookup table, no ordering to reason about.
 *
 * Anything without an explicit stub gets `{ ok: true, items: [] }` -- an
 * empty, successful read. That is deliberately the *quiet* answer: peripheral
 * furniture (announcements, the gym wall, chat) should not decide whether a
 * journey passes, and a 500 there would paint error banners over the thing
 * the journey is actually looking at. Whatever a journey asserts on, it stubs
 * explicitly.
 */
export async function installPilotApi(page: Page, options: InstallPilotApiOptions): Promise<string[]> {
  const { session, routes = {} } = options;
  const unstubbed = options.unstubbed ?? [];

  await page.route('**/api/pilot/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === SESSION_ROUTE) {
      if (!session) {
        await fulfillJson(route, { authenticated: false }, 401);
        return;
      }
      await fulfillJson(route, sessionPayload(session));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(routes, path)) {
      const handler = routes[path];
      const body = typeof handler === 'function' ? handler(url, route) : handler;
      await fulfillJson(route, body);
      return;
    }

    if (!unstubbed.includes(path)) {
      unstubbed.push(path);
    }
    await fulfillJson(route, { ok: true, items: [] });
  });

  return unstubbed;
}

/**
 * The Bell, for every role that signs in federated.
 *
 * This walks the half of the Microsoft journey that belongs to the browser.
 * The other half -- the redirect out to Microsoft and back -- happens at an
 * identity provider this suite has no business simulating, and it ends by
 * setting the session cookie and returning the person to the app. What
 * follows *is* this: SignInPanel's mount effect asks the server who is
 * holding the cookie, and the app routes on the answer. Nothing here is
 * faked except that answer.
 *
 * Returns when the browser has actually arrived at the role's workspace URL.
 */
export async function signInAtTheBell(
  page: Page,
  options: InstallPilotApiOptions & { readonly landOn?: string },
): Promise<void> {
  await installPilotApi(page, options);
  await page.goto('/login');

  const destination = options.landOn
    ?? (options.session ? ROLE_DESTINATION[options.session.role] : '/login');
  await page.waitForURL(`**${destination}`);
}

/**
 * The athlete's own door: Account ID and PIN, typed into the real form.
 *
 * No identity provider is involved in this one, so unlike the Bell above this
 * is the entire journey -- the form, POST /api/pilot/auth/login, the session
 * read, and the routing decision -- driven exactly as a child at the gym
 * tablet drives it.
 *
 * `landOn` exists because /athlete/dashboard is server-guarded (see
 * SERVER_GUARDED_ROUTES): a caller that expects to be bounced says so rather
 * than the helper pretending otherwise.
 */
export async function signInAtTheAthleteDoor(
  page: Page,
  options: InstallPilotApiOptions & {
    readonly accountId: string;
    readonly pin: string;
    readonly loginResponse?: PilotApiBody | PilotApiHandler;
  },
): Promise<void> {
  await installPilotApi(page, {
    ...options,
    routes: {
      [LOGIN_ROUTE]: options.loginResponse ?? {
        ok: true,
        role: options.session?.role ?? 'athlete',
        athlete_id: 'athlete-001',
      },
      ...(options.routes ?? {}),
    },
  });

  await page.goto('/athlete/sign-in');
  await page.getByLabel(/Athlete Account ID/i).fill(options.accountId);
  await page.getByLabel(/^PIN/i).fill(options.pin);
  await page.getByRole('button', { name: /Sign In/i }).click();
}

/** Navigate to a client-gated surface with the session already installed.
    Separate from the sign-in walk on purpose: a journey should sign in once,
    then move like a person -- click a link, or open a bookmark. */
export async function openSignedIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
}
