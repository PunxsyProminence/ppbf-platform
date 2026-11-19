/** @jest-environment jsdom */
/**
 * Lane U1, SC2-4 (app scrub; Jason's card OW25-48 A, "Medical-stop mark only
 * for a medical stop", applied to every page by Overwatch's Q6).
 *
 * - A count of injury flags, or of program alerts, is not a clearance
 *   decision. Its tile is on the restricted rung with ▲ and its number; the
 *   --locked mark is for MEDICALLY_NOT_ALLOWED from the clearance record.
 * - ATH-13: the HELP toggle no longer pins min-h-[44px] at the call site. A
 *   call-site utility outranks the base layer (app/globals.css), so it held
 *   the toggle at 44px even under data-surface="kiosk", where the floor is 55px.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import { AdminSummaryPanel, CoachSummaryPanel, HelpPanel } from './RoleSummaryPanels';

function tileFor(label: string): HTMLElement {
  const heading = screen.getByText(label, { selector: 'p.t-label' });
  return heading.parentElement as HTMLElement;
}

describe('summary tiles: a count is not a medical stop', () => {
  test('flagged injuries are restricted with ▲ and the count, never the --locked mark', () => {
    render(
      <CoachSummaryPanel sessionStatus={null} activeAthletes={6} injuryFlags={2} reviewsNeeded={0} assignmentsDue={0} />,
    );
    const tile = tileFor('Injuries');
    expect(tile.className).toContain('var(--restricted)');
    expect(tile.className).not.toContain('var(--locked)');
    expect(tile).toHaveTextContent('▲ 2');
    expect(tile.textContent).not.toContain('✕');
  });

  test('no injuries flagged: the plain tile, no glyph', () => {
    render(
      <CoachSummaryPanel sessionStatus={null} activeAthletes={6} injuryFlags={0} reviewsNeeded={0} assignmentsDue={0} />,
    );
    const tile = tileFor('Injuries');
    expect(tile.className).not.toContain('var(--restricted)');
    expect(tile.textContent).not.toContain('▲');
  });

  test('flagged program alerts are restricted with ▲, like the board tile beside them', () => {
    render(<AdminSummaryPanel programAlerts={3} boardAlerts={1} openAssignments={0} complianceItems={0} pendingReviews={0} />);
    const program = tileFor('Program');
    expect(program.className).toContain('var(--restricted)');
    expect(program.className).not.toContain('var(--locked)');
    expect(program).toHaveTextContent('▲ 3');
    expect(tileFor('Board').className).toContain('var(--restricted)');
  });
});

describe('ATH-13: the HELP toggle takes the tap floor from the base layer', () => {
  test('the toggle carries no call-site min-height', () => {
    render(<HelpPanel title="Wellness" description="d" usage={[]} mistakes={[]} />);
    const toggle = screen.getByRole('button', { name: /HELP: Wellness/ });
    expect(toggle.className).not.toMatch(/min-h-/);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
