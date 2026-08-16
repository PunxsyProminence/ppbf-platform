/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import StaffCredentialsUploadPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const ITEMS = [
  {
    clearance_type_id: 'ct-safesport', name: 'SafeSport Training', issuing_authority: 'U.S. Center for SafeSport',
    validity_months: 12, status: 'not_started', band: 'missing', issued_on: null, expires_on: null,
    verification_note: null, has_document: false,
  },
  {
    clearance_type_id: 'ct-cpr', name: 'CPR/First Aid', issuing_authority: 'American Red Cross',
    validity_months: 24, status: 'current', band: 'current', issued_on: '2026-01-01', expires_on: '2028-01-01',
    verification_note: null, has_document: true,
  },
];

function mockFetch(capturePosts?: unknown[]) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      capturePosts?.push(init.body);
      return { ok: true, json: async () => ({ ok: true, status: 'submitted' }) } as Response;
    }
    if (url.includes('/coach/credentials')) {
      return { ok: true, json: async () => ({ items: ITEMS }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('lists each clearance type with its own status badge', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<StaffCredentialsUploadPage />);
  });

  expect(await screen.findByText('SafeSport Training')).toBeTruthy();
  expect(screen.getByText('CPR/First Aid')).toBeTruthy();
  expect(screen.getByText('Not on file')).toBeTruthy();
  expect(screen.getByText('Current')).toBeTruthy();
});

test('says out loud that an upload does not become current by itself', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<StaffCredentialsUploadPage />);
  });

  expect(await screen.findByText(/awaiting review/i)).toBeTruthy();
  expect(screen.getByText(/only an administrator can confirm/i)).toBeTruthy();
});

test('shows a note from the office when one is on record', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/coach/credentials')) {
      return {
        ok: true,
        json: async () => ({
          items: [{
            ...ITEMS[0],
            verification_note: 'photo is illegible, please rescan',
          }],
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  await act(async () => {
    render(<StaffCredentialsUploadPage />);
  });

  expect(await screen.findByText(/photo is illegible, please rescan/i)).toBeTruthy();
});

test('refuses to upload with no file chosen, without calling the server', async () => {
  const posts: unknown[] = [];
  global.fetch = mockFetch(posts);

  await act(async () => {
    render(<StaffCredentialsUploadPage />);
  });

  const uploadButtons = await screen.findAllByRole('button', { name: /upload document/i });
  await act(async () => {
    fireEvent.click(uploadButtons[0]);
  });

  expect(posts).toHaveLength(0);
  expect(screen.getByText(/choose a file/i)).toBeTruthy();
});

test('uploading a chosen file posts multipart form data with the clearance_type_id', async () => {
  const posts: unknown[] = [];
  global.fetch = mockFetch(posts);

  await act(async () => {
    render(<StaffCredentialsUploadPage />);
  });

  const fileInput = document.getElementById('file-ct-safesport') as HTMLInputElement;
  const file = new File(['%PDF-1.4'], 'cert.pdf', { type: 'application/pdf' });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
  });

  const uploadButtons = await screen.findAllByRole('button', { name: /upload document/i });
  await act(async () => {
    fireEvent.click(uploadButtons[0]);
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]).toBeInstanceOf(FormData);
  const formData = posts[0] as FormData;
  expect(formData.get('clearance_type_id')).toBe('ct-safesport');
  expect((formData.get('document') as File).name).toBe('cert.pdf');
});
