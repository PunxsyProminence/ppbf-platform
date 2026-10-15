/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';

import ShadowChatButton from './ShadowChatButton';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  window.localStorage.clear();
});

function answerSessionAs(role: string): void {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ authenticated: true, role }),
  })) as unknown as typeof fetch;
}

describe('the SHADOW button names the reader’s role in words (F-008)', () => {
  test.each([
    ['platform_owner', 'Platform owner', 'PLATFORM_OWNER'],
    ['organization_admin', 'Gym admin', 'ORGANIZATION_ADMIN'],
    ['coach', 'Coach', 'COACH'],
  ])('%s reads as "%s", never as the stored value', async (role, words, stored) => {
    answerSessionAs(role);
    await act(async () => {
      render(<ShadowChatButton />);
    });

    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByText(stored)).toBeNull();
    // The link still carries the real role to /shadow.
    expect(screen.getByRole('link').getAttribute('href')).toContain(`role=${role}`);
  });
});
