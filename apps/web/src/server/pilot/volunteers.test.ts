jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { getBoardVolunteerSummary } from './volunteers';
import { queryOne } from './db';

const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('getBoardVolunteerSummary', () => {
  test('a status bucket under the minimum comes back insufficient_data, never a small real number', async () => {
    mockQueryOne.mockResolvedValueOnce({
      active_count: 3,
      pending_count: 0,
      inactive_count: 0,
      new_count: 1,
    });

    const summary = await getBoardVolunteerSummary('org-1');

    expect(summary.volunteersByStatus.active.status).toBe('insufficient_data');
    expect(summary.volunteersByStatus.active.count).toBeNull();
    expect(summary.volunteersByStatus.pending.status).toBe('unavailable');
    expect(summary.newVolunteers30Days.status).toBe('insufficient_data');
    expect(summary.newVolunteers30Days.count).toBeNull();
  });

  test('a status bucket at or above the minimum reports the real count', async () => {
    mockQueryOne.mockResolvedValueOnce({
      active_count: 8,
      pending_count: 2,
      inactive_count: 0,
      new_count: 6,
    });

    const summary = await getBoardVolunteerSummary('org-1');

    expect(summary.volunteersByStatus.active).toEqual({ status: 'available', count: 8 });
    expect(summary.volunteersByStatus.pending).toEqual({ status: 'insufficient_data', count: null });
    expect(summary.volunteersByStatus.inactive).toEqual({ status: 'unavailable', count: null });
    expect(summary.newVolunteers30Days).toEqual({ status: 'available', count: 6 });
  });

  test('preserves the fixed contract shape and the shared k-anonymity floor', async () => {
    mockQueryOne.mockResolvedValueOnce({
      active_count: 8,
      pending_count: 2,
      inactive_count: 0,
      new_count: 6,
    });

    const summary = await getBoardVolunteerSummary('org-1');

    expect(Object.keys(summary)).toEqual([
      'scope',
      'minimumCohortSize',
      'generatedAt',
      'volunteersByStatus',
      'newVolunteers30Days',
    ]);
    expect(summary.scope).toBe('organization_aggregate');
    expect(summary.minimumCohortSize).toBe(5);
  });

  test('missing rows come back as a fully suppressed/unavailable summary rather than throwing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const summary = await getBoardVolunteerSummary('org-1');

    expect(summary.volunteersByStatus.active).toEqual({ status: 'unavailable', count: null });
    expect(summary.volunteersByStatus.pending).toEqual({ status: 'unavailable', count: null });
    expect(summary.volunteersByStatus.inactive).toEqual({ status: 'unavailable', count: null });
    expect(summary.newVolunteers30Days).toEqual({ status: 'unavailable', count: null });
  });

  // The board-cannot-see-identifying-fields guarantee: neither the query this
  // module sends nor the object it returns may carry a volunteer_id,
  // account_id, full_name, role_focus, certification_status,
  // background_check_status, or notes -- exactly the columns
  // pilot.volunteers otherwise exposes to organization_admin via
  // listVolunteers/SELECT_COLUMNS.
  test('never reads an individual volunteer row -- counts only, no identifying columns', async () => {
    mockQueryOne.mockResolvedValueOnce({
      active_count: 0,
      pending_count: 0,
      inactive_count: 0,
      new_count: 0,
    });

    const summary = await getBoardVolunteerSummary('org-1');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-1']);
    expect(String(sql)).not.toMatch(/select\s+\*/i);
    expect(String(sql)).not.toMatch(
      /\b(full_name|notes|account_id|volunteer_id|role_focus|certification_status|background_check_status)\b/i,
    );
    expect(JSON.stringify(summary)).not.toMatch(
      /accountId|account_id|volunteerId|volunteer_id|full_name|fullName|notes|certification|background_check|roleFocus|role_focus/i,
    );
  });

  test('scopes the read to the caller organization and nothing else', async () => {
    mockQueryOne.mockResolvedValueOnce({
      active_count: 0,
      pending_count: 0,
      inactive_count: 0,
      new_count: 0,
    });

    await getBoardVolunteerSummary('org-authenticated');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-authenticated']);
    expect(String(sql)).toMatch(/organization_id = \$1/);
  });
});
