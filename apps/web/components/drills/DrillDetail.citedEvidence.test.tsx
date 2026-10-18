/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import DrillDetail from './DrillDetail';
import { fromCoachDrillDetail } from './drillDetailView';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';

// Audit 2026-10-17 item 11, the surfaces other than /coach/drills. The
// assignment instruction (coach cards, progression intelligence) does not
// read the Library, so it points the coach to the Drill Library instead of
// claiming a load failed -- and still never lists the ids bare.

const drill = {
  drill_id: 'reference-1',
  name: 'Jab return',
  discipline: 'boxing',
  category: 'technical',
  difficulty: 'beginner',
  skill_id: 'SK-JAB-01',
  contact_level: 'light_technical',
  requires_coach_authorization: false,
  version: 1,
  lineage_id: 'reference-1',
  supersedes_drill_id: null,
  superseded_at: null,
  active: true,
  field_provenance: 'LITERATURE-GROUNDED DRAFT',
  content_class: 'COACHING CRAFT',
  source_ref: 'PPBF research program 2026-08-07',
  grounding_claim_ids: [' A2-070', 'A2-070', 'A3-032 ', ''],
  scale_levels: [],
  stop_rules: [],
  cues: [],
  secondary_skills: [],
} as unknown as DrillWithDetail;

describe('cited evidence on a surface that does not read the Library', () => {
  it('points to the Drill Library, counting each distinct id once, and shows no id bare', () => {
    const view = fromCoachDrillDetail(drill);
    expect(view.coach?.groundingClaimIds).toEqual(['A2-070', 'A3-032']);

    render(<DrillDetail view={view} audience="coach" />);

    expect(screen.getByText('Cited evidence (2)')).toBeInTheDocument();
    expect(screen.getByText('Open this drill in the Drill Library to read the 2 research claims it cites.')).toBeInTheDocument();
    expect(screen.queryByText(/A2-070/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it('says a failed read failed', () => {
    render(<DrillDetail view={fromCoachDrillDetail(drill, null)} audience="coach" />);

    expect(screen.getByText('A2-070: the evidence for this reference could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('A3-032: the evidence for this reference could not be loaded.')).toBeInTheDocument();
  });
});
