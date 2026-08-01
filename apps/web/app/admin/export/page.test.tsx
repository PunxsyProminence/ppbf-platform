/**
 * @jest-environment jsdom
 */

// The export screen has one job beyond starting the download: never let a
// failure look like a successful export of an empty gym. A refused read has to
// say so, and a count the server did not send must not be printed as a zero.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import RosterExportPage, { filenameFromContentDisposition } from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let clickedAnchors: HTMLAnchorElement[];
let clickSpy: jest.SpyInstance;

beforeEach(() => {
  clickedAnchors = [];
  URL.createObjectURL = jest.fn(() => 'blob:roster');
  URL.revokeObjectURL = jest.fn();
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  clickSpy.mockRestore();
  jest.clearAllMocks();
});

function csvResponse(headers: Record<string, string>) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    blob: async () => new Blob(['"Athlete ID"\r\n'], { type: 'text/csv' }),
    json: async () => ({}),
  } as unknown as Response;
}

function errorResponse(status: number, error: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    blob: async () => new Blob([]),
    json: async () => ({ error }),
  } as unknown as Response;
}

function clickDownload() {
  fireEvent.click(screen.getByRole('button', { name: /download roster/i }));
}

describe('filenameFromContentDisposition', () => {
  test('reads the name the server chose', () => {
    expect(filenameFromContentDisposition('attachment; filename="ppbf-roster-org-ppbf-2026-08-01.csv"'))
      .toBe('ppbf-roster-org-ppbf-2026-08-01.csv');
  });

  test('reports no name rather than inventing one', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
  });
});

describe('the roster export screen', () => {
  test('names every column the file will contain', () => {
    render(<RosterExportPage />);

    expect(screen.getByText('Athlete ID')).toBeTruthy();
    expect(screen.getByText('Date of birth')).toBeTruthy();
    expect(screen.getByText('Guardians')).toBeTruthy();
    expect(screen.getByText('Emergency contact phone')).toBeTruthy();
  });

  test('saves the file under the name the server sent and reports the count', async () => {
    global.fetch = jest.fn(async () => csvResponse({
      'content-disposition': 'attachment; filename="ppbf-roster-org-ppbf-2026-08-01.csv"',
      'x-roster-row-count': '41',
    })) as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await screen.findByText(/ppbf-roster-org-ppbf-2026-08-01\.csv/);
    expect(screen.getByText(/with 41 athletes/)).toBeTruthy();
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].download).toBe('ppbf-roster-org-ppbf-2026-08-01.csv');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:roster');
  });

  test('sends the session cookie with the download request', async () => {
    const fetchMock = jest.fn(async () => csvResponse({ 'x-roster-row-count': '0' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(String(calls[0][0])).toContain('/api/pilot/admin/export/roster');
    expect(calls[0][1].credentials).toBe('include');
  });

  test('says the read failed instead of showing an export of nothing', async () => {
    global.fetch = jest.fn(async () => errorResponse(403, 'Forbidden: role not allowed')) as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await screen.findByText(/Nothing was downloaded\. Forbidden: role not allowed/);
    expect(screen.queryByText(/Saved/)).toBeNull();
    expect(clickedAnchors).toHaveLength(0);
  });

  test('reports an unlabelled failure with its status rather than silently', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await screen.findByText(/The export failed \(HTTP 503\)\./);
  });

  test('does not print a zero it was never given', async () => {
    global.fetch = jest.fn(async () => csvResponse({
      'content-disposition': 'attachment; filename="ppbf-roster-org-ppbf-2026-08-01.csv"',
    })) as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await screen.findByText(/did not report how many athletes it holds/);
    expect(screen.queryByText(/with 0 athletes/)).toBeNull();
  });

  test('reports a genuinely empty roster as zero athletes', async () => {
    global.fetch = jest.fn(async () => csvResponse({
      'content-disposition': 'attachment; filename="ppbf-roster-org-ppbf-2026-08-01.csv"',
      'x-roster-row-count': '0',
    })) as unknown as typeof fetch;

    render(<RosterExportPage />);
    clickDownload();

    await screen.findByText(/with 0 athletes/);
  });
});
