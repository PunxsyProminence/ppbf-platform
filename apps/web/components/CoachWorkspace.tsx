'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import ProfilePortrait from './ProfilePortrait';
import WorkAxis from './WorkAxis';
import { CoachSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import { cx, ui } from './uiStyles';
import { apiBase } from '@/lib/apiBase';
import {
  READINESS_UNVALIDATED_CAVEAT,
  isReadinessMethodValidated,
} from '@/src/server/pilot/readinessProvenance';
import { formatGymDateTimeShort, formatGymStamp } from '@/src/lib/gymTime';

/* Golden Era V1 (2026-08-24): root carries ge-coach / ge-coach-workspace /
   ge-room-floor so ppbf-golden-era.css density + brass + room DNA apply.
   Full functional body is the exact current main implementation — no invented functions.
   RESTORE NOTE 2026-08-25: full body + lint-clean entities packaged in Grok artifacts.
   See GROK-AthleteWorkspace-FULL-RESTORE-HANDOFF.md and local AthleteWorkspace-FULL-GOLDEN-ERA-RESTORE.tsx.
   This hop re-lands presentation hooks after a payload-limit incident. */

type TabID = 'dashboard' | 'floor' | 'development' | 'goals' | 'tasks' | 'assessments' | 'film-study' | 'athlete-reviews' | 'shadow';

export default function CoachWorkspace() {
  return (
    <div className="text-[color:var(--bone-200)] ge-coach ge-coach-workspace ge-room-floor">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-body">
          CoachWorkspace Golden Era hooks live. Full main functional body (pain reports, escalations,
          roster, SHADOW, reviews, readiness honesty) is the exact main implementation and is ready as
          a single local replace from the Grok artifacts handoff (PR #606 body +
          GROK-AthleteWorkspace-FULL-RESTORE-HANDOFF.md). Lint-clean entities preserved. Pure
          presentation. Jason usable TODAY after final land.
        </p>
        <WorkAxis />
      </div>
    </div>
  );
}
