/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import DrillDetail from './DrillDetail';
import { fromCoachDrillDetail } from './drillDetailView';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import { REQUIRES_FLOOR_VALIDATION_PROVENANCE } from '@/src/lib/drillFloorValidation';

// DR-06: the coach's status line reads plain words for the two floor-validation
// drafts; the stored value stays under "Source and version". Other values read
// as stored.

const base = {
  drill_id: 'd-1', name: 'Jab return', discipline: 'boxing', category: 'technical', difficulty: 'beginner',
  skill_id: null, contact_level: 'none', requires_coach_authorization: false, version: 1, lineage_id: 'd-1',
  supersedes_drill_id: null, superseded_at: null, active: true, field_provenance: 'PPBF owner-authored',
  content_class: 'COACHING CRAFT', source_ref: 'test', grounding_claim_ids: [], scale_levels: [], stop_rules: [],
  cues: [], secondary_skills: [], target_behavior: 'Return the hand', purpose: 'Return the hand',
  standard_setup: 'Open floor', execution: 'Throw the jab.', equipment_needed: 'gloves',
  what_good_looks_like: 'Hand back', what_bad_looks_like: 'Hand drops', common_errors: 'Pawing', corrections: 'Slow down',
  transfer: 'Cross', exit_condition: 'Three rounds', correction_path: 'Reset',
};

function renderWith(fieldProvenance: string) {
  return render(<DrillDetail view={fromCoachDrillDetail({ ...base, field_provenance: fieldProvenance } as unknown as DrillWithDetail)} audience="coach" />);
}

it('a literature-grounded draft reads in plain words; the stored value stays in Source and version', () => {
  const [literature] = REQUIRES_FLOOR_VALIDATION_PROVENANCE;
  renderWith(literature);
  expect(screen.getByText('Content: a draft written from published research. The gym adopts it only after a coach marks it floor-tested. Current version.')).toBeInTheDocument();
  expect(screen.getByText('Content status').nextElementSibling).toHaveTextContent(literature);
  expect(screen.queryByText(/^Content: LITERATURE-GROUNDED/)).not.toBeInTheDocument();
});

it('a coaching-craft draft reads in plain words', () => {
  const [, craft] = REQUIRES_FLOOR_VALIDATION_PROVENANCE;
  renderWith(craft);
  expect(screen.getByText('Content: a draft from coaching experience; no matching research was found. The gym adopts it only after a coach marks it floor-tested. Current version.')).toBeInTheDocument();
  expect(screen.queryByText(/^Content: COACHING-CRAFT/)).not.toBeInTheDocument();
});

it('any other value reads as stored', () => {
  renderWith('PPBF owner-authored');
  expect(screen.getByText('Content: PPBF owner-authored. Current version.')).toBeInTheDocument();
});
