import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { setParentTaskDueDate } from '@/src/server/pilot/parentTasks';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
// requireActual, not a bare object: parentTasks.canSetParentTask calls
// isOrganizationAdminRole out of this module, and a mock that omits it makes
// the real role predicate throw rather than decide.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

// canSetParentTask is NOT mocked -- the real role predicate decides, so these
// tests pin the route's actual authorisation rather than a double of it.
jest.mock('@/src/server/pilot/parentTasks', () => {
  const actual = jest.requireActual('@/src/server/pilot/parentTasks');
  return { ...actual, setParentTaskDueDate: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockSetDue = jest.mocked(setParentTaskDueDate);
const mockAudit = jest.mocked(writePilotAuditEvent);

beforeEach(() => {
  jest.clearAllMocks();
  mockSetDue.mockResolvedValue({
    noteId: 'note-1', dueDate: '2026-09-10', completedAt: null, completedByAccountId: null,
  });
});

function principal(role: string) {
  return {
    accountId: 'acct-1', role, organizationId: 'org-a',
    athleteId: null, sessionToken: 't', authProvider: 'microsoft' as const,
  } as never;
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/parent-tasks', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
}

test('a coach may set a due date on a message about a child they can reach', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  const res = await post({ note_id: 'note-1', athlete_id: 'ath-1', due_date: '2026-09-10' });

  expect(res.status).toBe(200);
  expect(mockAssertAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), 'ath-1');
  expect(mockSetDue).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-a', noteId: 'note-1', dueDate: '2026-09-10', actorAccountId: 'acct-1',
  }));
});

test('a guardian may not, and is stopped before any athlete lookup', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('parent'));

  const res = await post({ note_id: 'note-1', athlete_id: 'ath-1', due_date: '2026-09-10' });

  expect(res.status).not.toBe(200);
  expect(mockAssertAccess).not.toHaveBeenCalled();
  expect(mockSetDue).not.toHaveBeenCalled();
});

test('an athlete may not', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('athlete'));
  const res = await post({ note_id: 'note-1', athlete_id: 'ath-1', due_date: '2026-09-10' });
  expect(res.status).not.toBe(200);
  expect(mockSetDue).not.toHaveBeenCalled();
});

/* The athlete gate runs BEFORE the note is looked up, so a coach off this
   child's roster never learns whether the note exists. */
test('a coach off the roster is refused without the note being touched', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
  mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

  const res = await post({ note_id: 'note-1', athlete_id: 'ath-other', due_date: '2026-09-10' });

  expect(res.status).not.toBe(200);
  expect(mockSetDue).not.toHaveBeenCalled();
});

test('athlete_id is required, so the gate can never be skipped by omitting it', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  const res = await post({ note_id: 'note-1', due_date: '2026-09-10' });

  expect(res.status).not.toBe(200);
  expect(mockAssertAccess).not.toHaveBeenCalled();
  expect(mockSetDue).not.toHaveBeenCalled();
});

test('a null due date clears rather than being rejected, and the audit says which', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
  mockSetDue.mockResolvedValueOnce({
    noteId: 'note-1', dueDate: null, completedAt: null, completedByAccountId: null,
  });

  const res = await post({ note_id: 'note-1', athlete_id: 'ath-1', due_date: null });

  expect(res.status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: { action: 'parent_task_due_cleared' },
  }));
});
