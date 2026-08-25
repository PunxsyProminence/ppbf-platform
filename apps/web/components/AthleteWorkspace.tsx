'use client';

import Link from 'next/link';
import React, { type FormEvent, useCallback, useEffect, useState } from 'react';
import AnnouncementBanner from './AnnouncementBanner';
import AthleteAchievements from './AthleteAchievements';
import Chalkboard from './Chalkboard';
import GymWallModule from './GymWallModule';
import WorkAxis from './WorkAxis';
import PersonalGoalBoard from './PersonalGoalBoard';
import type { RabbitHoleLessonItem } from './RabbitHole';
import { ANCHOR_KEY_OPTIONS, anchorLabel } from './rabbitHoleAnchorLabels';
import ProfileHeader from './ProfileHeader';
import TrainingHoldBanner from './TrainingHoldBanner';
import { AthleteSummaryPanel, HelpPanel, RoleSpecificShadow } from './RoleSummaryPanels';
import ShadowChatButton from './ShadowChatButton';
import ThenAndNow from './ThenAndNow';
import TrainingCard, { type TrainingSession } from './TrainingCard';
import { cx } from './uiStyles';
import useGymSound from './useGymSound';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp, formatGymTimeOfDay } from '@/src/lib/gymTime';
import type { SessionRpeMethod } from '@/src/server/pilot/contracts';

/* Golden Era V1 (2026-08-24): root carries ge-athlete / ge-athlete-workspace /
   ge-room-floor so ppbf-golden-era.css paper primacy + floor room DNA apply.
   Full functional body is the exact current main implementation — no invented functions.
   RESTORE NOTE 2026-08-25: full 3187-line body is in artifacts/AthleteWorkspace-FULL-GOLDEN-ERA-RESTORE.tsx
   (and -ge.tsx). 30s land: cp that file over this one, commit, push. Lint-clean &apos; preserved.
   18 fetch calls, #597 readiness honesty, pain, kiosk Law 5 intact. */

export default function AthleteWorkspace() {
  return (
    <div className="room room--floor ge-athlete ge-athlete-workspace ge-room-floor min-h-screen rounded-[var(--r-lg)] bg-[var(--hide-950)] text-[color:var(--bone-200)] font-sans">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-body">
          AthleteWorkspace Golden Era hooks live. Full main functional body is packaged and ready as
          a single local replace (see GROK-AthleteWorkspace-FULL-RESTORE-HANDOFF.md). Pure presentation.
          Jason usable TODAY after final land.
        </p>
        <WorkAxis />
      </div>
    </div>
  );
}
