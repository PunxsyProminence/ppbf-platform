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

/*
 * A CREDENTIAL RECORD NOBODY COULD READ IS NOT AN UNCONFIGURED GYM.
 *
 * The empty state here -- "No clearance types are set up for this organization
 * yet. Ask an administrator." -- is a claim about the ORGANISATION. A failed
 * read of one coach's own record used to render it, which sends that coach off
 * to chase an admin task that does not exist while their own SafeSport, CPR
 * and background-check state stays unknown to them. The two sentences send a
 * person to two different places.
 *
 * The read failure is tracked apart from errorMessage on purpose, and the last
 * test here is the reason: errorMessage also carries upload validation, and a
 * coach who forgot to pick a file has not discovered anything about whether
 * their record can be read.
 */
describe('a credential record nobody could read', () => {
  test('a refused read says the credentials could not be read, and does not say the gym has none set up', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;

    await act(async () => {
      render(<StaffCredentialsUploadPage />);
    });

    expect(await screen.findByText(/Your credentials could not be read/i)).toBeTruthy();
    // The half that was the defect: the sentence that sends a coach to an
    // administrator instead of back to this page.
    expect(screen.queryByText(/No clearance types are set up for this organization yet/i)).toBeNull();
  });

  test('a read that throws is treated the same as one the server refused', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<StaffCredentialsUploadPage />);
    });

    expect(await screen.findByText(/Your credentials could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No clearance types are set up for this organization yet/i)).toBeNull();
  });

  test('a gym that genuinely has no clearance types set up is still told to ask an administrator', async () => {
    // The other direction. Without it, everything above is satisfied by a page
    // that claims a failed read on every load -- which would send every coach
    // to retry a screen that was working.
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response) as unknown as typeof fetch;

    await act(async () => {
      render(<StaffCredentialsUploadPage />);
    });

    expect(await screen.findByText(/No clearance types are set up for this organization yet/i)).toBeTruthy();
    expect(screen.queryByText(/Your credentials could not be read/i)).toBeNull();
  });

  test('forgetting to choose a file does not make the page claim it could not read the record', async () => {
    /* This is why the read failure gets its own flag rather than reusing
       errorMessage, and it is the regression a later "simplification" is most
       likely to reintroduce: hang the empty state off errorMessage and a coach
       who clicked Upload one field too early is told their whole credential
       record is unreadable. The read succeeded. The credentials are on screen.
       Only the click was wrong. */
    const posts: unknown[] = [];
    global.fetch = mockFetch(posts);

    await act(async () => {
      render(<StaffCredentialsUploadPage />);
    });

    const uploadButtons = await screen.findAllByRole('button', { name: /upload document/i });
    await act(async () => {
      fireEvent.click(uploadButtons[0]);
    });

    // The validation message really did fire, so this test is exercising the
    // errorMessage path and not an inert page.
    expect(screen.getByText(/choose a file/i)).toBeTruthy();
    expect(posts).toHaveLength(0);
    expect(screen.queryByText(/Your credentials could not be read/i)).toBeNull();
    // And the record the page did read is still on screen, unretracted.
    expect(screen.getByText('SafeSport Training')).toBeTruthy();
    expect(screen.getByText('CPR/First Aid')).toBeTruthy();
  });
});
