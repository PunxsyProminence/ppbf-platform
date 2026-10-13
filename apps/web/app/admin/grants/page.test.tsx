/**
 * @jest-environment jsdom
 */

// The obligations ledger is a deadlines board. What these pin: the empty
// state is withheld while loading; an overdue open row is flagged and a
// settled row never is; and advancing a row PATCHes the ledger rather than
// mutating anything client-side.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import GrantObligationsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const OVERDUE_ROW = {
  obligation_id: 'ob-1',
  grant_name: 'Community Youth Grant',
  funder_name: 'Foundation X',
  obligation_type: 'report',
  description: 'Quarterly outcomes report.',
  due_date: '2020-01-01',
  status: 'open',
  completed_at: null,
  notes: '',
};

const SETTLED_OLD_ROW = {
  ...OVERDUE_ROW,
  obligation_id: 'ob-2',
  grant_name: 'Equipment Grant',
  status: 'complete',
};

function mockFetch(rows: unknown[], capture?: { patches: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      capture?.patches.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    return { ok: true, json: async () => ({ items: rows }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while loading', async () => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

  render(<GrantObligationsPage />);

  await screen.findByText(/Loading obligations/);
  expect(screen.queryByText('No obligations on record')).toBeNull();
});

test('an overdue open row is flagged; a settled row with the same old date is not', async () => {
  global.fetch = mockFetch([OVERDUE_ROW, SETTLED_OLD_ROW]);

  render(<GrantObligationsPage />);

  // The ledger list; the report above it names the same grants (RP-03).
  const list = await screen.findByRole('list');
  await within(list).findByText('Community Youth Grant');
  expect(within(list).getAllByText('overdue')).toHaveLength(1);
  expect(within(list).getByText('Equipment Grant')).toBeTruthy();
});

test('advancing a row PATCHes the ledger with the target status', async () => {
  const capture = { patches: [] as unknown[] };
  global.fetch = mockFetch([OVERDUE_ROW], capture);

  render(<GrantObligationsPage />);

  await within(await screen.findByRole('list')).findByText('Community Youth Grant');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Mark submitted' }));
  });

  expect(capture.patches).toEqual([{ obligation_id: 'ob-1', status: 'submitted' }]);
});

test('a failed read says the obligations could not be read, never "No obligations on record"', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;

  render(<GrantObligationsPage />);

  await screen.findByText('Obligations could not be read');
  expect(screen.queryByText('No obligations on record')).toBeNull();
});

test('a failed re-read after a create does not go back to "No obligations on record"', async () => {
  let gets = 0;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ item: {} }) } as Response;
    gets += 1;
    return gets === 1
      ? ({ ok: true, json: async () => ({ items: [] }) } as Response)
      : ({ ok: false, status: 500, json: async () => ({}) } as Response);
  }) as unknown as typeof fetch;

  render(<GrantObligationsPage />);

  await screen.findByText('No obligations on record');
  fireEvent.click(screen.getByRole('button', { name: 'Add obligation' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save obligation' }));
  });

  await screen.findByText('Obligations could not be read');
  expect(screen.queryByText('No obligations on record')).toBeNull();
});

/*
 * THE OBLIGATIONS REPORT (RP-03): a summary by grant and funder for the chosen
 * state and due range, Print, and a CSV download that says when it fails.
 */
describe('the obligations report section (RP-03)', () => {
  const createObjectURL = jest.fn(() => 'blob:report');
  const ROWS = [
    { ...OVERDUE_ROW, obligation_id: 'r1' },
    { ...OVERDUE_ROW, obligation_id: 'r2', status: 'in_progress', due_date: '2099-01-01' },
    { ...SETTLED_OLD_ROW, obligation_id: 'r3', funder_name: '' },
  ];

  beforeEach(() => {
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  function reportFetch(csvOk: boolean) {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('format=csv')) {
        return csvOk
          ? ({ ok: true, blob: async () => new Blob(['x']) } as unknown as Response)
          : ({ ok: false, json: async () => ({ error: 'Forbidden' }) } as unknown as Response);
      }
      return { ok: true, json: async () => ({ items: ROWS }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function summaryRow(grant: string): string[] {
    const report = screen.getByRole('region', { name: 'Obligations report' });
    const cells = within(report).getByText(grant).closest('tr')!.querySelectorAll('td');
    return Array.from(cells).map((cell) => cell.textContent ?? '');
  }

  test('grouped by grant and funder, with open, settled and overdue counts; the state filter narrows it', async () => {
    reportFetch(true);
    render(<GrantObligationsPage />);
    await screen.findByRole('region', { name: 'Obligations report' });

    expect(summaryRow('Community Youth Grant')).toEqual(['Community Youth Grant', 'Foundation X', '2', '2', '0', '1']);
    expect(summaryRow('Equipment Grant')).toEqual(['Equipment Grant', '—', '1', '0', '1', '0']);

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'open' } });
    const report = screen.getByRole('region', { name: 'Obligations report' });
    expect(within(report).queryByText('Equipment Grant')).toBeNull();
  });

  test('Print prints; Download CSV asks the server for the chosen state and range', async () => {
    const fetchMock = reportFetch(true);
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<GrantObligationsPage />);
    await screen.findByRole('region', { name: 'Obligations report' });

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'settled' } });
    fireEvent.change(screen.getByLabelText('Due from'), { target: { value: '2020-01-01' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    const csvCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('format=csv'));
    expect(csvCalls).toHaveLength(1);
    expect(String(csvCalls[0]![0])).toContain('format=csv&state=settled&from=2020-01-01');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test('the report states its scope, so a filtered printout reads as filtered', async () => {
    reportFetch(true);
    render(<GrantObligationsPage />);
    const report = await screen.findByRole('region', { name: 'Obligations report' });

    expect(within(report).getByText('Showing: All obligations, due any date to any date.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'open' } });
    fireEvent.change(screen.getByLabelText('Due from'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Due to'), { target: { value: '2026-10-31' } });
    const scope = within(report).getByText('Showing: Open obligations, due 2026-10-01 to 2026-10-31.');
    expect(scope.className).not.toContain('print:hidden');
    expect(scope.closest(String.raw`.print\:hidden`)).toBeNull();
  });

  test('a reversed range is not printed as an empty report', async () => {
    reportFetch(true);
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    render(<GrantObligationsPage />);
    const report = await screen.findByRole('region', { name: 'Obligations report' });

    fireEvent.change(screen.getByLabelText('Due from'), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText('Due to'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));

    expect(print).not.toHaveBeenCalled();
    expect(within(report).getByRole('alert').textContent).toContain('on or before');
    expect(within(report).queryByText('No obligations match.')).toBeNull();
  });

  test('a reversed range is not sent, and the sentence clears once the dates change', async () => {
    const fetchMock = reportFetch(true);
    render(<GrantObligationsPage />);
    const report = await screen.findByRole('region', { name: 'Obligations report' });

    fireEvent.change(screen.getByLabelText('Due from'), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText('Due to'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));

    expect(within(report).getByRole('alert').textContent).toContain('on or before');
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('format=csv'))).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Due to'), { target: { value: '2026-10-31' } });
    expect(within(report).queryByRole('alert')).toBeNull();
  });

  test('on paper: the report prints; the add button, the form toggle and the list do not', async () => {
    reportFetch(true);
    render(<GrantObligationsPage />);
    const report = await screen.findByRole('region', { name: 'Obligations report' });

    expect(report.className).not.toContain('print:hidden');
    expect(screen.getByRole('button', { name: 'Add obligation' }).parentElement!.className).toContain('print:hidden');
    expect(screen.getByRole('list').className).toContain('print:hidden');
  });

  test('a refused download says so and saves nothing', async () => {
    reportFetch(false);
    render(<GrantObligationsPage />);
    await screen.findByRole('region', { name: 'Obligations report' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    });

    const report = screen.getByRole('region', { name: 'Obligations report' });
    expect(within(report).getByRole('alert').textContent).toContain('Forbidden');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
