/**
 * @jest-environment jsdom
 */

// /change-pin is the one signed-in page with no session bar controls: a
// session still owing a PIN change is never written to the role-session
// cache, so GlobalRoleHeader draws its signed-out mark here. Until this page
// carried its own Logout, an athlete sent here on a shared gym tablet could
// only choose a PIN or walk away signed in. These pin that the control is
// present, that it is the session bar's own sign-out (same label, same call,
// same landing), and that the PIN form it sits beside is unchanged.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';

const push = jest.fn();
const replace = jest.fn();
const clearRoleSession = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => '/change-pin',
}));

jest.mock('@/components/roleSession', () => ({
  clearRoleSession: (...args: unknown[]) => clearRoleSession(...args),
}));

import ChangePinPage from './page';

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('/change-pin offers the session bar\'s sign-out', () => {
  test('a Logout control is present, outside the PIN form', () => {
    render(<ChangePinPage />);

    const logout = screen.getByRole('button', { name: 'Logout' });
    expect(logout.getAttribute('type')).toBe('button');
    // Not a child of the form: pressing it can never submit the PIN fields.
    expect(logout.closest('form')).toBeNull();
  });

  test('pressing Logout posts to /api/pilot/auth/logout with credentials, clears the cache and lands on /login', () => {
    render(<ChangePinPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    const fetchMock = global.fetch as unknown as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/pilot/auth/logout');
    // The same call the session bar makes (GlobalRoleHeader.tsx signOut):
    // credentials or the cookie is not sent cross-origin and nothing is
    // revoked; keepalive or a document load cancels the request.
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true });
    expect(clearRoleSession).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/login');
    expect(push).not.toHaveBeenCalled();
  });

  test('the PIN form is unchanged: three PIN fields and Save My PIN, which stays disabled until all three are filled', () => {
    render(<ChangePinPage />);

    // getByLabelText throws if a field is missing, so three calls are three assertions.
    const given = screen.getByLabelText('The PIN you were given') as HTMLInputElement;
    const fresh = screen.getByLabelText('Your new PIN') as HTMLInputElement;
    const again = screen.getByLabelText('Type your new PIN again') as HTMLInputElement;
    for (const field of [given, fresh, again]) {
      expect(field.closest('form')).not.toBeNull();
      expect(field.getAttribute('type')).toBe('password');
    }
    const save = screen.getByRole('button', { name: 'Save My PIN' }) as HTMLButtonElement;
    expect(save.getAttribute('type')).toBe('submit');
    expect(save.disabled).toBe(true);
    // Logout is the only other button on the page, and Save My PIN comes
    // first in document order, so it is first in tab order.
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Save My PIN', 'Logout']);
  });

  test('pressing Logout does not touch the PIN endpoint', () => {
    render(<ChangePinPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    const fetchMock = global.fetch as unknown as jest.Mock;
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/api/pilot/auth/change-pin'))).toBe(false);
  });

  // The control is the session bar's, not a new one: same label and class
  // constant, and the same three-part sign-out. Read off both sources so a
  // change to the bar's pattern shows up here as a disagreement.
  test('the control reuses the session bar\'s sign-out pattern rather than inventing one', () => {
    const web = path.resolve(__dirname, '../..');
    const page = readFileSync(path.join(web, 'app', 'change-pin', 'page.tsx'), 'utf8');
    const header = readFileSync(path.join(web, 'components', 'GlobalRoleHeader.tsx'), 'utf8');

    expect(page).toContain('className={CONTROL_EXIT}');
    expect(header).toContain('className={CONTROL_EXIT}');

    const logoutLine = (source: string) => source
      .split(/\r?\n/)
      .filter((line) => line.includes('auth/logout') && line.includes('fetch('))
      .map((line) => line.trim());
    expect(logoutLine(page)).toEqual(logoutLine(header));
  });
});
