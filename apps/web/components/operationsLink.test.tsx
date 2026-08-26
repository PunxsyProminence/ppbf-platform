/**
 * @jest-environment jsdom
 */

/**
 * THE COMPONENT THE WHOLE RESTRICTION ROUTES THROUGH.
 *
 * <OperationsLink> is what eleven pages now use in place of a hardcoded link,
 * so its guard is the single thing standing between those pages and the
 * behaviour this change removed. An adversarial review deleted that guard --
 * leaving the component to render the link unconditionally, which restores an
 * Operations control on /help for a signed-out visitor, on /notices, on
 * /schedule, on /research/chat, on two coach surfaces and on both
 * /operations/ sub-pages -- and NOT ONE test in the repository turned red. It
 * compiles cleanly too, so typecheck said nothing either.
 *
 * This file is that mutation's answer. It drives the real role-session store
 * rather than mocking the component's own dependency, because a test that
 * mocks `canUseOperationsHub` proves the mock.
 *
 * THE NULL CASE IS THE ONE NOTHING ELSE COVERS, and it is the reason the
 * component reads `session?.role ?? null` instead of asserting a session
 * exists. Null is two real situations: the signed-out visitor on an ungated
 * page like /help, and the window on EVERY page before the session resolves.
 * A component that opened on null would put the control on screen for a
 * moment on every page in the building, and "only for a moment" is not a
 * property anyone can rely on -- getRoleSessionSnapshot answers from
 * localStorage, so how long that window lasts is a function of the device.
 */

import { render, screen } from '@testing-library/react';

import OperationsLink from './OperationsLink';
import { OPERATIONS_ROLES } from './operationsAccess';
import type { ClubRole } from './roleRoutes';
import { clearRoleSession, createPersistentRoleSession } from './roleSession';

function renderAs(role: ClubRole | null) {
  clearRoleSession();
  if (role) createPersistentRoleSession(role);
  render(<OperationsLink className="btn btn--ghost">Mission Control</OperationsLink>);
}

const link = () => screen.queryByRole('link', { name: 'Mission Control' });

afterEach(() => {
  clearRoleSession();
});

/* Read from the shared source rather than restated, so a role added to the
   decision is admitted here without anybody remembering to edit this file --
   and a role REMOVED from it lands in the refused table below by the same
   mechanism. */
const ADMITTED = [...OPERATIONS_ROLES] as ClubRole[];

const REFUSED: ClubRole[] = [
  'athlete',
  'coach',
  'parent',
  'staff',
  'volunteer',
  'board',
];

it('names both sides, so neither table below runs over an empty list', () => {
  expect(ADMITTED.length).toBeGreaterThan(0);
  expect(REFUSED.length).toBeGreaterThan(0);
  // No role may sit in both tables -- that would make one of them vacuous.
  expect(REFUSED.filter((role) => (ADMITTED as string[]).includes(role))).toEqual([]);
});

it.each(ADMITTED)('renders the link for %s, with the page\'s own classes', (role) => {
  renderAs(role);

  const anchor = link() as HTMLAnchorElement;
  expect(anchor).not.toBeNull();
  expect(anchor.getAttribute('href')).toBe('/operations');
  /* The className passes through untouched. The session bar's Operations
     control was once measured at 11.8px against its 15px siblings because a
     wrapper substituted its own classes; this component must never style. */
  expect(anchor.getAttribute('class')).toBe('btn btn--ghost');
});

it.each(REFUSED)('renders nothing at all for %s', (role) => {
  renderAs(role);

  expect(link()).toBeNull();
  // Not an empty anchor, not a disabled one, not a tooltip -- nothing.
  expect(screen.queryByText('Mission Control')).toBeNull();
});

/* The two situations that produce a null session, asserted separately from
   the role tables because they are not roles and would otherwise be tested
   only by accident. */
it('renders nothing for a signed-out visitor, which is /help and every ungated page', () => {
  renderAs(null);

  expect(link()).toBeNull();
});

it('renders nothing while a session is still unresolved, so the control cannot flash', () => {
  /* No session in the store yet -- the state every page passes through on
     first paint. The server-snapshot argument returns null too, so this is
     also what a server render produces. */
  clearRoleSession();
  render(<OperationsLink className="btn">Back to Operations</OperationsLink>);

  expect(screen.queryByRole('link', { name: 'Back to Operations' })).toBeNull();
});

/* A control that appears once the answer arrives is the whole point: this is
   not a component that hides the hub, it is one that offers it to the right
   reader. Asserted so that "renders nothing" can never be satisfied by a
   component that renders nothing ever. */
it('offers the link once an admitted session exists', () => {
  renderAs('admin');

  expect(link()).not.toBeNull();
});
