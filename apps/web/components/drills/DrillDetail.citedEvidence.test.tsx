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

  it('rises to the kiosk floors only on a gym-floor page (OD-2026-11-17-009 ruling 4)', () => {
    const { container } = render(<DrillDetail view={fromCoachDrillDetail(drill)} audience="coach" />);
    for (const summary of container.querySelectorAll('summary')) {
      expect(summary.className).toContain('min-h-[44px]');
      expect(summary.className).toContain('in-data-[surface=kiosk]:min-h-[var(--tap)]');
    }
    const sized = container.querySelectorAll('[class*="in-data-[surface=kiosk]:text-[length:var(--t-md)]"]');
    expect(sized.length).toBeGreaterThan(0);
    // Every small text size on the card has its kiosk rise beside it.
    for (const node of container.querySelectorAll('[class*="--t-sm"], [class*="--t-xs"]')) {
      expect(node.className).toContain('in-data-[surface=kiosk]:text-[length:var(--t-md)]');
    }
  });

  // On /coach/drills the card is light parchment, where the bone inks read at
  // 1.01:1 (--bone-300) and 1.22:1 (--bone-200); inside .ge-drillcase that text
  // takes the card's own ink. A .t-label and a list item already do, through
  // the card's unlayered rules (ppbf-golden-era.css, .mat-leather--raised).
  it('every bone colour and the link in the source carry the card-ink fallback (all branches, not only those rendered)', () => {
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const path = jest.requireActual('node:path') as typeof import('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'DrillDetail.tsx'), 'utf8');
    const lines = source.split('\n');
    const bone = lines.filter((line) => /--bone-\d00\)\]/.test(line) && !line.trim().startsWith('//'));
    expect(bone.length).toBeGreaterThan(10);
    for (const line of bone) {
      // A .t-label takes the card's label ink from the card's own unlayered rule.
      if (line.includes('t-label')) continue;
      expect(line.includes('in-[.ge-drillcase]:text-[color:inherit]') || line.includes('${CARD_INK}') ? 'covered' : line.trim()).toBe('covered');
    }
    const links = lines.filter((line) => /className="underline/.test(line));
    expect(links.length).toBeGreaterThan(0);
    for (const line of links) expect(line).toContain('in-[.ge-drillcase]:text-[color:inherit]');
  });

  it('no bone ink is left on the parchment card without the card-ink fallback', () => {
    const { container } = render(<main className="ge-drillcase"><DrillDetail view={fromCoachDrillDetail(drill)} audience="coach" /></main>);
    const bone = [...container.querySelectorAll('[class*="--bone-"]')];
    expect(bone.length).toBeGreaterThan(0);
    for (const node of bone) {
      if (node.classList.contains('t-label') || node.tagName === 'LI') continue;
      expect(node.className).toContain('in-[.ge-drillcase]:text-[color:inherit]');
    }
  });

  it('says a failed read failed', () => {
    render(<DrillDetail view={fromCoachDrillDetail(drill, null)} audience="coach" />);

    expect(screen.getByText('A2-070: the evidence for this reference could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('A3-032: the evidence for this reference could not be loaded.')).toBeInTheDocument();
  });
});
