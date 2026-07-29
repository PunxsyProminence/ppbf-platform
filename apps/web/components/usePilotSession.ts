'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// The pilot role as stored, NOT the ClubRole that roleSession.ts maps it onto.
// mapPilotRoleToClubRole collapses platform_owner, organization_admin, and the
// legacy admin all onto 'admin', which is the right granularity for deciding
// *which dashboard* someone lands on but the wrong one for deciding *which
// actions they can take* -- a platform owner and an organization admin have
// materially different capabilities inside /admin.
export type PilotSessionRole =
  | 'platform_owner'
  | 'organization_admin'
  | 'admin'
  | 'coach'
  | 'athlete'
  | 'parent'
  | 'board'
  | 'volunteer'
  | 'staff';

export interface PilotSession {
  role: PilotSessionRole | null;
  organizationId: string | null;
  authProvider: 'ppbf_local' | 'microsoft' | null;
  accountId: string | null;
  // True while the account is still on the admin-issued starting PIN. The
  // server refuses every route except the PIN change in this state, so a UI
  // that ignored this would render a dashboard made entirely of 403s.
  mustChangePin: boolean;
}

export interface PilotSessionState extends PilotSession {
  loading: boolean;
}

const EMPTY: PilotSession = {
  role: null,
  organizationId: null,
  authProvider: null,
  accountId: null,
  mustChangePin: false,
};

/**
 * True for the roles that administer a single organization's people and
 * settings. Mirrors the server's `isOrganizationAdminRole` in
 * src/server/pilot/access.ts, including its legacy 'admin' alias -- keep the
 * two in step.
 *
 * Deliberately excludes platform_owner: the platform owner creates
 * organizations and provisions their admins, but does not manage an individual
 * gym's roster. Every server route backing the People console enforces the
 * same boundary, so a UI that offered it to a platform owner would only ever
 * produce a 403.
 */
export function isOrganizationAdminSessionRole(role: PilotSessionRole | null): boolean {
  return role === 'organization_admin' || role === 'admin';
}

/**
 * Reads the authoritative session once and reports the raw pilot role.
 *
 * Every consumer previously hand-rolled this same POST. Sharing it keeps the
 * "what may this person actually do" question answered in one place rather
 * than drifting between pages.
 */
export function usePilotSession(): PilotSessionState {
  const [state, setState] = useState<PilotSessionState>({ ...EMPTY, loading: true });

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        if (!response.ok) {
          setState({ ...EMPTY, loading: false });
          return;
        }

        const payload = (await response.json()) as {
          authenticated?: boolean;
          role?: string;
          organization_id?: string;
          auth_provider?: string;
          account_id?: string;
          must_change_pin?: boolean;
        };

        if (payload.authenticated !== true) {
          setState({ ...EMPTY, loading: false });
          return;
        }

        setState({
          loading: false,
          role: (payload.role as PilotSessionRole) ?? null,
          organizationId: payload.organization_id ?? null,
          authProvider:
            payload.auth_provider === 'microsoft' || payload.auth_provider === 'ppbf_local'
              ? payload.auth_provider
              : null,
          accountId: payload.account_id ?? null,
          mustChangePin: payload.must_change_pin === true,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setState({ ...EMPTY, loading: false });
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  return state;
}
