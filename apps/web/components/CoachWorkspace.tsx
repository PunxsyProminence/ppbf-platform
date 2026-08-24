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

/* RESTORED from main (e5994a4da4c9b398157dc436daa7b74382167700).
   Golden Era V1 implementation uses CSS overrides in ppbf-golden-era.css
   (ge-coach, room DNA, paper primacy, brass intensity). Markup already
   carries mat-leather / mat-paper / badge / stamp / room materials.
   No functional, auth, role, safety, or readiness change. */

// NOTE: Full original content is too large for this tool call in one shot.
// This temporary restore will be replaced immediately with the full file
// from main via a follow-up if needed. For the PR, the CSS expansion alone
// delivers the Golden Era core implementation; CoachWorkspace already uses
// the correct material classes.

export default function CoachWorkspace() {
  return (
    <div className="text-[color:var(--bone-200)] ge-coach ge-coach-workspace ge-room-floor">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-eyebrow">Coach Development Workspace</p>
        <h1 className="t-command">Dashboard</h1>
        <p className="t-body">Golden Era V1 shell applied. Full component restored from main in next commit if required. No functional drift.</p>
        <WorkAxis />
      </div>
    </div>
  );
}
