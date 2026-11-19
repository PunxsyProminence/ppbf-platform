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
  exit_condition: '',
  correction_path: null,
} as unknown as DrillWithDetail;

const filled = {
  ...base,
  what_good_looks_like: 'Hand back at the chin',
  what_bad_looks_like: 'Hand drops',
  common_errors: 'Pawing the jab',
  corrections: 'Slow the tempo',
  transfer: 'Carries to the cross',
  exit_condition: 'Three clean rounds',
  correction_path: 'Reset the stance\nShorten the step',
} as unknown as DrillWithDetail;

describe('empty drill fields read "Not written yet"', () => {
  it('coach view: every empty teaching section says so, none is blank or 0', () => {
    const { container } = render(<DrillDetail view={fromCoachDrillDetail(empty)} audience="coach" />);
    // good, bad, common errors, corrections, transfer, exit condition, correction path
    expect(screen.getAllByText('Not written yet')).toHaveLength(7);
    expect(screen.getByText('What good looks like')).toBeInTheDocument();
    expect(screen.getByText('What to avoid')).toBeInTheDocument();
    expect(screen.getByText('Common errors')).toBeInTheDocument();
    expect(screen.getByText('Corrections')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
    expect(screen.getByText('Exit condition')).toBeInTheDocument();
    expect(screen.getByText('Correction path')).toBeInTheDocument();
    // Guard: no list item is empty or a bare zero.
    for (const li of container.querySelectorAll('li')) {
      expect((li.textContent ?? '').trim()).not.toBe('');
      expect((li.textContent ?? '').trim()).not.toBe('0');
    }
  });

  it('athlete view: the teaching sections say so', () => {
    render(<DrillDetail view={fromAthleteDrillDetail(empty as never)} audience="athlete" />);
    // good, bad, common errors, corrections, exit condition, correction path; transfer is coach-only.
    expect(screen.getAllByText('Not written yet')).toHaveLength(6);
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
    const third = render(<DrillDetail view={fromCoachDrillDetail(d8)} audience="coach" />);
    expect(screen.getByText('Equipment').nextElementSibling).toHaveTextContent('No equipment needed');
    third.unmount();

    // A newer version of a D8 drill: new drill_id, same lineage_id.
    const newer = { ...d8, drill_id: 'drl_newer_version', lineage_id: 'drl_7f812fecacfee4' } as unknown as DrillWithDetail;
    render(<DrillDetail view={fromCoachDrillDetail(newer)} audience="coach" />);
    expect(screen.getByText('Equipment').nextElementSibling).toHaveTextContent('No equipment needed');
  });

  it('filled fields are shown as written and no "Not written yet" appears', () => {
    render(<DrillDetail view={fromCoachDrillDetail(filled)} audience="coach" />);
    for (const text of ['Hand back at the chin', 'Hand drops', 'Pawing the jab', 'Slow the tempo', 'Carries to the cross', 'Three clean rounds', 'Reset the stance', 'Shorten the step']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByText('Not written yet')).not.toBeInTheDocument();
  });
});

// Lane NW-b (PK-197 A: "Show the two fields as not written, never as empty or complete").
describe('exit condition and correction path (lane NW-b)', () => {
  const textOf = (element: Element | null) => (element?.textContent ?? '').trim();
  const itemsUnder = (heading: string) => [...(screen.getByText(heading).nextElementSibling?.querySelectorAll('li') ?? [])].map(textOf);

  for (const audience of ['coach', 'athlete'] as const) {
    const view = (drill: DrillWithDetail) => (audience === 'coach' ? fromCoachDrillDetail(drill) : fromAthleteDrillDetail(drill as never));

    it(`${audience}: each field shows as written, one line per line`, () => {
      render(<DrillDetail view={view(filled)} audience={audience} />);
      expect(itemsUnder('Exit condition')).toEqual(['Three clean rounds']);
      expect(itemsUnder('Correction path')).toEqual(['Reset the stance', 'Shorten the step']);
    });

    it(`${audience}: an empty, blank or missing field shows "Not written yet", never blank`, () => {
      for (const [exit, path] of [['', null], ['  ', '\n'], [undefined, undefined]]) {
        const drill = { ...empty, exit_condition: exit, correction_path: path } as unknown as DrillWithDetail;
        const { unmount } = render(<DrillDetail view={view(drill)} audience={audience} />);
        expect(itemsUnder('Exit condition')).toEqual(['Not written yet']);
        expect(itemsUnder('Correction path')).toEqual(['Not written yet']);
        unmount();
      }
    });

    it(`${audience}: the exit condition is its own open section after the common errors; the correction path sits in the Corrections expander`, () => {
      const { container } = render(<DrillDetail view={view(filled)} audience={audience} />);
      const exitHeading = screen.getByText('Exit condition');
      expect(exitHeading.tagName).toBe('H3');
      expect(exitHeading.closest('details')).toBeNull();
      const errors = screen.getByText('Common errors');
      expect(errors.compareDocumentPosition(exitHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const corrections = [...container.querySelectorAll('details')].find((details) => textOf(details.querySelector('summary')) === 'Corrections');
      expect(corrections).toBeDefined();
      expect(corrections!.contains(screen.getByText('Correction path'))).toBe(true);
    });
  }
});
