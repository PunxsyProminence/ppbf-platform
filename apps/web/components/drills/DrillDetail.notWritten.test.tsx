/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import DrillDetail from './DrillDetail';
import { fromAthleteDrillDetail, fromCoachDrillDetail } from './drillDetailView';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';

// Design rule 'Honest': an unknown value never looks blank, zero or complete.
// A standard teaching section the content left empty says "Not written yet";
// a section that holds text is shown exactly as written.

const base = {
  drill_id: 'd-1',
  name: 'Jab return',
  discipline: 'boxing',
  category: 'technical',
  difficulty: 'beginner',
  skill_id: null,
  contact_level: 'none',
  requires_coach_authorization: false,
  version: 1,
  lineage_id: 'd-1',
  supersedes_drill_id: null,
  superseded_at: null,
  active: true,
  field_provenance: 'PPBF owner-authored',
  content_class: 'COACHING CRAFT',
  source_ref: 'test',
  grounding_claim_ids: [],
  scale_levels: [],
  stop_rules: [],
  cues: [],
  secondary_skills: [],
  target_behavior: 'Return the hand',
  purpose: 'Return the hand',
  standard_setup: 'Open floor',
  execution: 'Throw the jab.',
  equipment_needed: 'gloves',
};

const empty = {
  ...base,
  what_good_looks_like: '',
  what_bad_looks_like: null,
  common_errors: '  ',
  corrections: null,
  transfer: '',
} as unknown as DrillWithDetail;

const filled = {
  ...base,
  what_good_looks_like: 'Hand back at the chin',
  what_bad_looks_like: 'Hand drops',
  common_errors: 'Pawing the jab',
  corrections: 'Slow the tempo',
  transfer: 'Carries to the cross',
} as unknown as DrillWithDetail;

describe('empty drill fields read "Not written yet"', () => {
  it('coach view: every empty teaching section says so, none is blank or 0', () => {
    const { container } = render(<DrillDetail view={fromCoachDrillDetail(empty)} audience="coach" />);
    // good, bad, common errors, corrections, transfer
    expect(screen.getAllByText('Not written yet')).toHaveLength(5);
    expect(screen.getByText('What good looks like')).toBeInTheDocument();
    expect(screen.getByText('What to avoid')).toBeInTheDocument();
    expect(screen.getByText('Common errors')).toBeInTheDocument();
    expect(screen.getByText('Corrections')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
    // Guard: no list item is empty or a bare zero.
    for (const li of container.querySelectorAll('li')) {
      expect((li.textContent ?? '').trim()).not.toBe('');
      expect((li.textContent ?? '').trim()).not.toBe('0');
    }
  });

  it('athlete view: the teaching sections say so', () => {
    render(<DrillDetail view={fromAthleteDrillDetail(empty as never)} audience="athlete" />);
    // good, bad, common errors, corrections; transfer is coach-only.
    expect(screen.getAllByText('Not written yet')).toHaveLength(4);
  });

  it('blank equipment reads "Not written yet"; "none" and the D8 drills read "No equipment needed"', () => {
    const blank = { ...filled, equipment_needed: '' } as unknown as DrillWithDetail;
    const { unmount } = render(<DrillDetail view={fromCoachDrillDetail(blank)} audience="coach" />);
    expect(screen.getByText('Equipment').nextElementSibling).toHaveTextContent('Not written yet');
    unmount();

    const none = { ...filled, equipment_needed: 'none' } as unknown as DrillWithDetail;
    const second = render(<DrillDetail view={fromCoachDrillDetail(none)} audience="coach" />);
    expect(screen.getByText('Equipment').nextElementSibling).toHaveTextContent('No equipment needed');
    second.unmount();

    const d8 = { ...filled, drill_id: 'drl_7f812fecacfee4', equipment_needed: '' } as unknown as DrillWithDetail;
    render(<DrillDetail view={fromCoachDrillDetail(d8)} audience="coach" />);
    expect(screen.getByText('Equipment').nextElementSibling).toHaveTextContent('No equipment needed');
  });

  it('filled fields are shown as written and no "Not written yet" appears', () => {
    render(<DrillDetail view={fromCoachDrillDetail(filled)} audience="coach" />);
    for (const text of ['Hand back at the chin', 'Hand drops', 'Pawing the jab', 'Slow the tempo', 'Carries to the cross']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByText('Not written yet')).not.toBeInTheDocument();
  });
});
