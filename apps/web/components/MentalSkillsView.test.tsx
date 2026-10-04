/**
 * @jest-environment jsdom
 */

// The shared view is read-only unless the athlete's own page passes onRemove
// (OD-2026-10-04-023): the guardian and coach pages render it without one.

import { render, screen } from '@testing-library/react';

import MentalSkillsView, { type MentalSkillsData } from './MentalSkillsView';

const data: MentalSkillsData = {
  current_cue: { entry_id: 'e-cue', cue_text: 'hands home', cue_kind: 'instructional', logged_on: '2026-10-03' },
  imagery_sessions: [{ entry_id: 'e-1', minutes: 7, logged_on: '2026-10-03' }],
};

test('without onRemove there is no Remove button', () => {
  render(<MentalSkillsView state="loaded" data={data} goals={[]} goalsState="loaded" subjectLabel="their" />);
  expect(screen.getByText('hands home')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('with onRemove each entry gets one, and a cue without an id gets none', () => {
  const onRemove = jest.fn();
  const { rerender } = render(
    <MentalSkillsView state="loaded" data={data} goals={[]} goalsState="loaded" subjectLabel="your" onRemove={onRemove} />,
  );
  expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(2);
  screen.getByRole('button', { name: 'Remove this cue' }).click();
  expect(onRemove).toHaveBeenCalledWith('e-cue');

  const noId = { ...data, current_cue: { cue_text: 'x', cue_kind: 'motivational' as const, logged_on: '2026-10-03' } };
  rerender(<MentalSkillsView state="loaded" data={noId} goals={[]} goalsState="loaded" subjectLabel="your" onRemove={onRemove} />);
  expect(screen.queryByRole('button', { name: 'Remove this cue' })).toBeNull();
});
