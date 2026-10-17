/** @jest-environment jsdom */

// The gym admin's profile form (lane L31 P3): it loads the stored row, shows
// the legal name read-only, and saves on the second press only -- the first
// names the gym. Any edit takes the arming back.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import GymProfileForm from './GymProfileForm';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const STORED = {
  brand: 'Ridgeway Lantern Boxing & Fitness',
  short_name: 'RLBF',
  common_name: 'Ridgeway Lantern',
  website_url: 'https://www.ridgeway-lantern.example',
  domain: 'ridgeway-lantern.example',
  ein: '',
  contact_email: 'office@ridgeway-lantern.example',
  donations_email: '',
  grants_email: '',
  established: '2031',
  town: 'Ridgeway',
  service_area: '',
  service_area_short: '',
  physical_street: '9 Kiln Road',
  physical_city: 'Ridgeway',
  physical_region: 'PA',
  physical_postal_code: '15853',
  mailing_address: '',
  head_coach_name: 'Morgan Hale',
};

function installFetch(onPost: (body: Record<string, unknown>) => { status: number; body: unknown } = (body) => ({ status: 200, body: { ok: true, profile: body.profile } })) {
  const posts: Record<string, unknown>[] = [];
  global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const answer = onPost(body);
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, legal_name: 'Ridgeway Lantern Boxing and Fitness', profile: STORED }) } as Response;
  }) as unknown as typeof fetch;
  return posts;
}

async function mount() {
  await act(async () => {
    render(<GymProfileForm />);
  });
  await screen.findByRole('form', { name: 'Gym profile' });
}

test('it loads the stored profile and shows the legal name, which it does not edit', async () => {
  installFetch();
  await mount();
  expect((screen.getByLabelText('Public name (as the gym writes it)') as HTMLInputElement).value).toBe('Ridgeway Lantern Boxing & Fitness');
  expect((screen.getByLabelText('Head coach') as HTMLInputElement).value).toBe('Morgan Hale');
  expect(screen.getByText('Ridgeway Lantern Boxing and Fitness')).toBeTruthy();
  expect(screen.queryByLabelText(/legal name/i)).toBeNull();
});

test('the first press names the gym and sends nothing; the second saves the whole profile', async () => {
  const posts = installFetch();
  await mount();
  fireEvent.change(screen.getByLabelText('Contact email'), { target: { value: 'front@ridgeway-lantern.example' } });

  fireEvent.click(screen.getByRole('button', { name: 'Save Gym Profile' }));
  expect(posts).toEqual([]);
  expect(screen.getByText(/Saves Ridgeway Lantern Boxing & Fitness's profile\. Every page that names the gym shows it within a minute/)).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "Save Ridgeway Lantern Boxing & Fitness's Profile" }));
  });
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({ profile: { ...STORED, contact_email: 'front@ridgeway-lantern.example' } });
  expect(screen.getByRole('status').textContent).toMatch(/^Saved\./);
  expect(screen.getByRole('button', { name: 'Save Gym Profile' })).toBeTruthy();
});

test('an edit after the first press takes the arming back', async () => {
  const posts = installFetch();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Save Gym Profile' }));
  fireEvent.change(screen.getByLabelText('Town (as the copy names it)'), { target: { value: 'Ridgeway Borough' } });
  expect(screen.queryByRole('button', { name: /^Save Ridgeway/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save Gym Profile' })).toBeTruthy();
  expect(posts).toEqual([]);
});

test('a refusal is shown in the server’s words, and nothing claims it saved', async () => {
  installFetch(() => ({ status: 400, body: { error: 'domain is required' } }));
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Save Gym Profile' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Save Ridgeway/ }));
  });
  expect(await screen.findByText('domain is required')).toBeTruthy();
  expect(screen.queryByText(/^Saved\./)).toBeNull();
});

test('a profile that cannot be read says so, with no form to save', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  await act(async () => {
    render(<GymProfileForm />);
  });
  expect(await screen.findByText('The gym profile could not be read just now.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
