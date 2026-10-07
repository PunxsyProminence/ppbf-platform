import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { listGymTvs, mintGymTvPairCode } from '@/src/server/pilot/gymTvs';

export const runtime = 'nodejs';

// The coach dashboard's Paired TVs capability (Jason, Q3: "it should be a capability in the
// coaches dashboard").
//
// GET lists the gym's TVs (name, status, when paired, when last seen, which session is on it).
// Never a hash: the code is shown once at mint and the key lives only in the TV's cookie.
//
// POST mints a pairing code for a new, named TV and returns the code ONCE. Staff only -- coach or
// organization admin (overwatch, 2026-10-07: "coach + organization_admin (staff)"). The budget on
// how many codes one person can mint is in the module, counted in the database.
const STAFF_ROLES = ['coach', 'organization_admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);
    const tvs = await listGymTvs(principal.organizationId);
    return NextResponse.json({ tvs });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);

    const body = (await request.json().catch(() => null)) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'BODY_OBJECT_EXPECTED' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const extras = Object.keys(record).filter((k) => k !== 'tv_name');
    if (extras.length > 0) {
      return NextResponse.json({ error: `UNEXPECTED_FIELD:${extras.sort().join(',')}` }, { status: 400 });
    }

    const minted = await mintGymTvPairCode(principal.organizationId, principal.accountId, record.tv_name);
    return NextResponse.json({ tv: minted }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
