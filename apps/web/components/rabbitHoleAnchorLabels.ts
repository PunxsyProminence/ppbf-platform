// Plain-language display layer for the rabbit hole anchor vocabularies.
//
// A lesson is stored against a STABLE KEY -- a gap type, a severity, a formula
// id -- never against display copy. The key is therefore the wrong thing to put
// in front of a person: an author choosing what a lesson is about should read
// the same words the rest of the app uses for that concept, and a published
// lesson should say what it is attached to in those words too.
//
// The vocabularies are declared here as well as in
// src/server/pilot/rabbitHoles.ts because an authoring surface is client-side
// and must not pull the database layer into the bundle.
// rabbitHoleAnchorLabels.test.ts asserts the two stay identical in both
// directions, so a vocabulary that grows on one side fails there rather than
// quietly offering an author a key the server will refuse.
//
// The two vocabularies whose values are ROWS rather than constants --
// 'drill' and 'compliance_rule' -- carry a label for the anchor type but no key
// list: their keys exist only for the organization that created them, so they
// cannot be enumerated here. They are named in ANCHOR_TYPE_LABELS so a lesson
// already anchored to one still reads correctly, and left out of
// AUTHORABLE_ANCHOR_TYPES because an authoring picker with no keys to offer is
// an empty control.

import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';
import { SHADOW_FORMULA_REGISTRY } from '@/src/server/pilot/formulas/registry';

import type { RabbitHoleAnchorType } from './RabbitHole';

/** The anchor types whose keys are constants, so a picker can list them all. */
export const AUTHORABLE_ANCHOR_TYPES = [
  'gap_type',
  'severity',
  'formula_id',
  'board_seat',
  'evidence_tier',
  'readiness_band',
] as const;

export type AuthorableAnchorType = (typeof AUTHORABLE_ANCHOR_TYPES)[number];

export interface AnchorKeyOption {
  readonly key: string;
  readonly label: string;
}

export const ANCHOR_TYPE_LABELS: Record<RabbitHoleAnchorType, string> = {
  gap_type: 'Progression gap type',
  severity: 'Gap severity',
  formula_id: 'SHADOW formula',
  board_seat: 'Board seat',
  evidence_tier: 'SHADOW evidence tier',
  readiness_band: 'Readiness band',
  compliance_rule: 'Compliance rule',
  drill: 'Drill',
};

// Sourced from their own authorities where one exists: the board seat labels
// are the seat workspace's own, and the formula names are the registry's, so a
// renamed seat or formula reads correctly here without being retyped.
export const ANCHOR_KEY_OPTIONS: Record<AuthorableAnchorType, readonly AnchorKeyOption[]> = {
  gap_type: [
    { key: 'technique', label: 'Technique' },
    { key: 'strength', label: 'Strength' },
    { key: 'endurance', label: 'Endurance' },
    { key: 'skill', label: 'Skill' },
    { key: 'mental', label: 'Mental' },
    { key: 'tactical', label: 'Tactical' },
  ],
  severity: [
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ],
  formula_id: SHADOW_FORMULA_REGISTRY.map((formula) => ({
    key: formula.id,
    label: `${formula.id} - ${formula.name}`,
  })),
  board_seat: boardSeatConfigs.map((seat) => ({ key: seat.slug, label: seat.seatLabel })),
  evidence_tier: [
    { key: 'PROVEN', label: 'PROVEN' },
    { key: 'EMERGING', label: 'EMERGING' },
    { key: 'EXPERIMENTAL', label: 'EXPERIMENTAL' },
    { key: 'RESEARCH_NEEDED', label: 'RESEARCH_NEEDED' },
  ],
  readiness_band: [
    { key: 'GREEN', label: 'GREEN' },
    { key: 'YELLOW', label: 'YELLOW' },
    { key: 'RED', label: 'RED' },
  ],
};

// Mirrors RABBIT_HOLE_AUDIENCES in src/server/pilot/rabbitHoles.ts, which is
// the account role vocabulary plus 'all'.
export const AUDIENCE_LABELS: Record<string, string> = {
  all: 'Everyone at the gym',
  platform_owner: 'Platform owner',
  organization_admin: 'Organization admins',
  admin: 'Admins',
  coach: 'Coaches',
  athlete: 'Athletes',
  parent: 'Parents',
  board: 'Board',
  volunteer: 'Volunteers',
  staff: 'Staff',
};

export const RABBIT_HOLE_AUDIENCE_OPTIONS: readonly string[] = [
  'all',
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

function isAuthorableAnchorType(value: string): value is AuthorableAnchorType {
  return (AUTHORABLE_ANCHOR_TYPES as readonly string[]).includes(value);
}

/**
 * The readable name of one anchor key.
 *
 * Falls back to the key itself, which is the honest answer for the two
 * organization-scoped vocabularies and for a key that has since left its
 * vocabulary: a stored lesson still says what it is attached to rather than
 * rendering a blank where a topic should be.
 */
export function anchorKeyLabel(anchorType: string, anchorKey: string): string {
  if (!isAuthorableAnchorType(anchorType)) {
    return anchorKey;
  }

  return ANCHOR_KEY_OPTIONS[anchorType].find((option) => option.key === anchorKey)?.label ?? anchorKey;
}

/** "Progression gap type: Technique" -- what a lesson is about, in full. */
export function anchorLabel(anchorType: string, anchorKey: string): string {
  const typeLabel = ANCHOR_TYPE_LABELS[anchorType as RabbitHoleAnchorType] ?? anchorType;
  return `${typeLabel}: ${anchorKeyLabel(anchorType, anchorKey)}`;
}

export function audienceLabel(audience: string): string {
  return AUDIENCE_LABELS[audience] ?? audience;
}
