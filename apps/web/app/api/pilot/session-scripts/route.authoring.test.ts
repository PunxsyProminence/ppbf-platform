import { NextRequest } from 'next/server';

import { PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  SessionScriptAuthoringError,
  createSessionScriptFromTemplate,
  editSessionScript,
} from '@/src/server/pilot/sessionScriptAuthoring';
import { getSessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// POST and PATCH /api/pilot/session-scripts: a coach makes a session script
// from a workout template and edits it. The module's own behaviour -- the
// blocks it writes, and that an edit of a delivered script is a new version --
// is proven against real PostgreSQL in sessionScriptAuthoring.pg.test.ts. What
// is proven here is the route's: who is admitted, whose gym is used, and what
// reaches the module. requireRole is the real one, so the role cases exercise
// the gate itself.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionScriptAuthoring', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionScriptAuthoring');
  return { ...actual, createSessionScriptFromTemplate: jest.fn(), editSessionScript: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionScripts', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionScripts');
  return { ...actual, listSessionScripts: jest.fn(), getSessionScriptWithDetail: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createSessionScriptFromTemplate as jest.Mock;
const mockEdit = editSessionScript as jest.Mock;
const mockDetail = getSessionScriptWithDetail as jest.Mock;

// Every PilotRole (contracts.ts), as a record so a role added to the union
// fails to compile here until someone says whether it may write a script.
const MAY_AUTHOR: Record<PilotRole, boolean> = {
  coach: true,
  organization_admin: true,
  // The legacy row name of an organization admin (roleAlias.ts).
  admin: true,
  platform_owner: false,
  athlete: false,
  parent: false,
  board: false,
  volunteer: false,
  staff: false,
};
const ROLES = Object.keys(MAY_AUTHOR) as PilotRole[];

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function send(handler: typeof POST, method: 'POST' | 'PATCH', body: unknown) {
  return handler(
    new NextRequest('http://localhost/api/pilot/session-scripts', {
      method,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}
const post = (body: unknown) => send(POST, 'POST', body);
const patch = (body: unknown) => send(PATCH, 'PATCH', body);

const BLOCK = { block_id: 'blk-1', block_label: 'Warm-up', start_offset_min: 0, end_offset_min: 10 };
// The least a PATCH must say: which script, and which state of it the editor read.
const READ_AT = '2026-10-13T15:00:00.000Z';
const EDIT = { script_id: 'scr-1', expected_updated_at: READ_AT };
const STORED = { script_id: 'scr-new', name: 'Tuesday juniors', blocks: [], renderings: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockCreate.mockResolvedValue({ script_id: 'scr-new', lineage_id: 'scr-new', version: 1, name: 'x', block_count: 3 });
  mockEdit.mockResolvedValue({ outcome: 'new_version', script_id: 'scr-new', version: 2 });
  mockDetail.mockResolvedValue(STORED);
});

describe('who may write a session script', () => {
  it.each(ROLES)('%s: POST and PATCH are admitted only for a coach or an organization admin', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    const created = await post({ template_id: 'wtp-1' });
    const edited = await patch({ ...EDIT, name: 'Renamed' });

    if (MAY_AUTHOR[role]) {
      expect(created.status).toBe(201);
      expect(edited.status).toBe(200);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockEdit).toHaveBeenCalledTimes(1);
    } else {
      expect(created.status).toBe(403);
      expect(edited.status).toBe(403);
      // A refusal that has already written is not a refusal.
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEdit).not.toHaveBeenCalled();
      expect(mockDetail).not.toHaveBeenCalled();
    }
  });

  it('refuses before the body is read, so a malformed request gets the same answer', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

    expect((await post('not json')).status).toBe(403);
    expect((await patch({ unexpected: true })).status).toBe(403);
  });

  it('an unauthenticated caller is 401 and nothing is written', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await post({ template_id: 'wtp-1' })).status).toBe(401);
    expect((await patch({ ...EDIT, name: 'Renamed' })).status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockEdit).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/session-scripts', () => {
  it("makes the script in the principal's gym, as the principal, and answers with the stored script", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1', organizationId: 'org-9' }));

    const response = await post({ template_id: ' wtp-1 ', name: 'Tuesday juniors' });

    expect(mockCreate).toHaveBeenCalledWith({
      organizationId: 'org-9',
      actorAccountId: 'admin-1',
      actorRole: 'organization_admin',
      templateId: 'wtp-1',
      name: 'Tuesday juniors',
    });
    expect(mockDetail).toHaveBeenCalledWith('org-9', 'scr-new');
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ script: STORED });
  });

  it('accepts no organization, author or block from the body', async () => {
    for (const extra of ['organization_id', 'created_by_account_id', 'blocks', 'script_id']) {
      const response = await post({ template_id: 'wtp-1', [extra]: 'x' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `UNEXPECTED_FIELD:${extra}` });
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s a body that names no template, or a name that is not text', async () => {
    for (const body of ['not json', [], {}, { template_id: '  ' }, { template_id: 7 }, { template_id: 'wtp-1', name: 7 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers a module refusal with its code and status, not a 500", async () => {
    mockCreate.mockRejectedValue(new SessionScriptAuthoringError('WORKOUT_TEMPLATE_NOT_FOUND', 404));

    const response = await post({ template_id: 'wtp-other-gym' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'WORKOUT_TEMPLATE_NOT_FOUND' });
  });
});

describe('PATCH /api/pilot/session-scripts', () => {
  it("edits in the principal's gym and says whether the script was updated or a new version was made", async () => {
    const response = await patch({ ...EDIT, name: 'Renamed', blocks: [BLOCK] });

    expect(mockEdit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scriptId: 'scr-1',
      name: 'Renamed',
      blocks: [BLOCK],
      expectedUpdatedAt: READ_AT,
    });
    // The script answered is the one the edit produced, which is the new row when a version was made.
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'scr-new');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'new_version', script: STORED });
  });

  it('accepts no organization or version from the body', async () => {
    for (const extra of ['organization_id', 'version', 'lineage_id', 'authoring_state']) {
      const response = await patch({ ...EDIT, [extra]: 'x' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: `UNEXPECTED_FIELD:${extra}` });
    }
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('400s a missing script id and a block that is not a whole edit', async () => {
    const bad = [
      {},
      { ...EDIT, script_id: '' },
      { ...EDIT, name: 7 },
      { ...EDIT, blocks: 'all' },
      { ...EDIT, blocks: [{ ...BLOCK, start_offset_min: '0' }] },
      { ...EDIT, blocks: [{ block_id: 'blk-1' }] },
      { ...EDIT, blocks: [null] },
    ];
    for (const body of bad) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('requires the state the editor read, so an edit can never skip the two-coaches check', async () => {
    for (const body of [{ script_id: 'scr-1', name: 'x' }, { ...EDIT, expected_updated_at: 'yesterday' }, { ...EDIT, expected_updated_at: 7 }]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'expected_updated_at' });
    }
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it('answers a script another coach saved in the meantime with 409 and its code', async () => {
    mockEdit.mockRejectedValue(new SessionScriptAuthoringError('SESSION_SCRIPT_CHANGED', 409));

    const response = await patch({ ...EDIT, name: 'Second save' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_SCRIPT_CHANGED' });
  });

  it('answers a superseded script with 409 and its code', async () => {
    mockEdit.mockRejectedValue(new SessionScriptAuthoringError('SESSION_SCRIPT_SUPERSEDED', 409));

    const response = await patch({ ...EDIT, script_id: 'scr-old', name: 'Late edit' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_SCRIPT_SUPERSEDED' });
  });
});
