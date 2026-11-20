/**
 * @jest-environment jsdom
 */

/*
 * The family pages' one child picker (app scrub FAM-11; lane AS-9, AS9-2).
 *   1. it opens on the remembered child when that child is in the list, else
 *      on the only child, else on nobody;
 *   2. with one child it shows nothing; with two or more and none chosen it
 *      asks "Choose a child";
 *   3. a pick is remembered for the next family page;
 *   4. a child with no name reads "Your child", and two that would read the
 *      same are told apart.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';

import FamilyChildPicker, { familyChildLabel, openingChild } from './FamilyChildPicker';

const KEY = 'ppbf.parent.chosenChild';
const ROSA = { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' };
const MARCUS = { athlete_id: 'ath-marcus', full_name: 'Marcus Webb' };

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('openingChild', () => {
  test('the remembered child, when it is one of these', () => {
    window.sessionStorage.setItem(KEY, MARCUS.athlete_id);
    expect(openingChild([ROSA, MARCUS])).toBe(MARCUS.athlete_id);
  });

  test('a remembered child who is not in this list is ignored', () => {
    window.sessionStorage.setItem(KEY, 'ath-someone-else');
    expect(openingChild([ROSA, MARCUS])).toBeNull();
    expect(openingChild([ROSA])).toBe(ROSA.athlete_id);
  });

  test('the only child, when none is remembered', () => {
    expect(openingChild([ROSA])).toBe(ROSA.athlete_id);
  });

  test('nobody, for two or more and none remembered, or for none', () => {
    expect(openingChild([ROSA, MARCUS])).toBeNull();
    expect(openingChild([])).toBeNull();
  });
});

describe('familyChildLabel', () => {
  test('the name on file, trimmed', () => {
    expect(familyChildLabel({ athlete_id: 'a1', full_name: '  Rosa Delgado ' }, [ROSA])).toBe('Rosa Delgado');
  });

  test('no name, or the roster\'s "Unknown", reads "Your child", never the id', () => {
    for (const full_name of [null, undefined, '', '   ', 'Unknown']) {
      const child = { athlete_id: 'ath-0001', full_name };
      expect(familyChildLabel(child, [child])).toBe('Your child');
    }
  });

  test('two that would read the same are told apart by the end of their id', () => {
    const twins = [{ athlete_id: 'ath-1111', full_name: 'Sam' }, { athlete_id: 'ath-2222', full_name: 'Sam' }];
    expect(twins.map((child) => familyChildLabel(child, twins))).toEqual(['Sam (1111)', 'Sam (2222)']);
    const unnamed = [{ athlete_id: 'ath-3333' }, { athlete_id: 'ath-4444', full_name: null }];
    expect(unnamed.map((child) => familyChildLabel(child, unnamed))).toEqual(['Your child (3333)', 'Your child (4444)']);
  });
});

describe('the picker', () => {
  test('shows nothing for one child or none', () => {
    const { container, rerender } = render(<FamilyChildPicker linked={[ROSA]} activeId={ROSA.athlete_id} onChoose={() => {}} />);
    expect(container.textContent).toBe('');
    rerender(<FamilyChildPicker linked={[]} activeId={null} onChoose={() => {}} />);
    expect(container.textContent).toBe('');
  });

  test('with none chosen it asks "Choose a child"; with one chosen it marks that one', () => {
    const { rerender } = render(<FamilyChildPicker linked={[ROSA, MARCUS]} activeId={null} onChoose={() => {}} />);
    const group = screen.getByRole('group', { name: 'Which child' });
    expect(within(group).getByText('Choose a child')).toBeTruthy();
    expect(within(group).getAllByRole('button').map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false']);

    rerender(<FamilyChildPicker linked={[ROSA, MARCUS]} activeId={MARCUS.athlete_id} onChoose={() => {}} />);
    expect(screen.queryByText('Choose a child')).toBeNull();
    expect(screen.getByRole('button', { name: 'Marcus Webb' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Rosa Delgado' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('a pick is told to the page and remembered for the next family page', () => {
    const onChoose = jest.fn();
    render(<FamilyChildPicker linked={[ROSA, MARCUS]} activeId={ROSA.athlete_id} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb' }));
    expect(onChoose).toHaveBeenCalledWith(MARCUS.athlete_id);
    expect(window.sessionStorage.getItem(KEY)).toBe(MARCUS.athlete_id);
  });

  test('the label can be named by the page', () => {
    render(<FamilyChildPicker linked={[ROSA, MARCUS]} activeId={null} onChoose={() => {}} label="Which child's record" />);
    expect(screen.getByRole('group', { name: "Which child's record" })).toBeTruthy();
  });
});
