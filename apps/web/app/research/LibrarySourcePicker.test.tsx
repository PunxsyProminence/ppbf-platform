/**
 * @jest-environment jsdom
 */

// RINT-05b. The picker has to work at about a thousand sources: typing part of
// a title narrows the list, the chosen source never silently drops out of it,
// and a shelf bigger than what was loaded is said out loud.

import { fireEvent, render, screen } from '@testing-library/react';

import LibrarySourcePicker, { filterLibrarySources } from './LibrarySourcePicker';

const MANY = Array.from({ length: 1_000 }, (_, index) => ({
  source_id: `src_${index}`,
  title: index === 737 ? 'Weight cutting in adolescent boxers' : `Paper number ${index}`,
}));

function optionTitles(): string[] {
  const select = screen.getByLabelText('Registered source') as HTMLSelectElement;
  return Array.from(select.options).slice(1).map((option) => option.textContent ?? '');
}

describe('filterLibrarySources', () => {
  it('matches part of a title, ignoring case and outer spaces', () => {
    expect(filterLibrarySources(MANY, '  WEIGHT cut ').map((source) => source.source_id)).toEqual(['src_737']);
  });

  it('an empty query keeps every source, in the order given', () => {
    expect(filterLibrarySources(MANY, '')).toHaveLength(1_000);
  });
});

describe('LibrarySourcePicker', () => {
  it('narrows a thousand sources to the one typed', () => {
    const onChange = jest.fn();
    render(<LibrarySourcePicker sources={MANY} value="" onChange={onChange} label="Registered source" placeholder="Choose…" />);
    expect(optionTitles()).toHaveLength(1_000);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'adolescent' } });
    expect(optionTitles()).toEqual(['Weight cutting in adolescent boxers']);
    expect(screen.getByText('1 of 1,000 sources match.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'src_737' } });
    expect(onChange).toHaveBeenCalledWith('src_737');
  });

  it('keeps the chosen source listed when the filter stops matching it', () => {
    render(<LibrarySourcePicker sources={MANY} value="src_3" onChange={() => {}} label="Registered source" placeholder="Choose…" />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'adolescent' } });
    expect(optionTitles()).toEqual(['Paper number 3', 'Weight cutting in adolescent boxers']);
    expect((screen.getByLabelText('Registered source') as HTMLSelectElement).value).toBe('src_3');
  });

  it('says when older sources were not loaded, and only then', () => {
    const { rerender } = render(
      <LibrarySourcePicker sources={MANY} value="" onChange={() => {}} label="Registered source" placeholder="Choose…" />,
    );
    expect(screen.queryByText(/Only the newest/)).toBeNull();
    rerender(<LibrarySourcePicker sources={MANY} value="" onChange={() => {}} label="Registered source" placeholder="Choose…" truncated />);
    expect(screen.getByText(/Only the newest 1,000 are listed/)).toBeTruthy();
  });
});
