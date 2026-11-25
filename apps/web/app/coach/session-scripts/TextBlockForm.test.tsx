/**
 * @jest-environment jsdom
 */

// The text block form (SP-2b). What these pin: the kinds are the migration's
// less drill_round and the contact levels are the server's ladder, each in
// plain words; the contact level starts empty and the block is not added until
// one is chosen (App Overwatch Q1 = C); words are needed for every kind but
// arrival, transition and close, and are capped at the server's 1000. The
// form's use inside the editor is in SessionScriptEditor.test.tsx.

import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

import TextBlockForm from './TextBlockForm';
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const addBlock = () => fireEvent.click(screen.getByRole('button', { name: 'Add this block' }));

function setup() {
  const onAdd = jest.fn();
  const onClose = jest.fn();
  render(<TextBlockForm onAdd={onAdd} onClose={onClose} />);
  return { onAdd, onClose };
}

const options = (label: string) =>
  within(screen.getByLabelText(label)).getAllByRole('option').map((option) => [(option as HTMLOptionElement).value, option.textContent]);

describe('the text block form', () => {
  it('offers the nine text kinds and the contact ladder in plain words, each starting on an empty choice', () => {
    setup();

    expect(options('Kind of block')).toEqual([
      ['', 'Choose the kind of block'],
      ['arrival', 'Arrival'],
      ['instruction', 'Instruction'],
      ['demonstration', 'Demo'],
      ['reset_minute', 'Reset'],
      ['teaching_minute', 'Teaching'],
      ['transition', 'Transition'],
      ['conditioning', 'Conditioning'],
      ['reflection', 'Reflection'],
      ['close', 'Close'],
    ]);
    expect(options('Contact level')).toEqual([
      ['', 'Choose the contact level'],
      ['none', 'No contact'],
      ['light_technical', 'Light technical contact'],
      ['conditioned', 'Conditioned contact'],
      ['controlled_sparring', 'Controlled sparring'],
      ['open_sparring', 'Open sparring'],
    ]);
    // The server's own ladder (sessionScriptAuthoring.ts CONTACT_LADDER is this list), nothing more or less.
    expect(options('Contact level').slice(1).map(([value]) => value)).toEqual([...VOCABULARIES.contact_level.values]);
    expect(screen.getByLabelText('Contact level')).toHaveValue('');
    expect(screen.getByLabelText('What to say')).toHaveAttribute('maxLength', '1000');
  });

  it('puts keyboard focus on the first field when it opens', () => {
    setup();

    expect(screen.getByLabelText('Kind of block')).toHaveFocus();
  });

  it('hands up the block as written, with the contact level the coach chose', () => {
    const { onAdd } = setup();

    type('Kind of block', 'instruction');
    type('Title', 'Guard talk');
    type('What to say', 'Hands up, chin down.');
    type('Contact level', 'light_technical');
    addBlock();

    expect(onAdd).toHaveBeenCalledWith({ block_kind: 'instruction', block_label: 'Guard talk', text: 'Hands up, chin down.', contact_level: 'light_technical' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a title of spaces is no title, and words the eye cannot see are no words (reviewers F and G)', () => {
    const { onAdd } = setup();

    type('Kind of block', 'instruction');
    type('Title', '   ');
    type('What to say', '\u2800\uFE0F \u200B');
    type('Contact level', 'none');
    addBlock();

    expect(screen.getByRole('alert')).toHaveTextContent('The block needs a title.');
    expect(screen.getByRole('alert')).toHaveTextContent('Write what to say in this block.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('a problem stops being shown once the coach changes the form (reviewer F)', () => {
    setup();

    type('Kind of block', 'instruction');
    type('Title', 'Guard talk');
    type('What to say', 'Hands up.');
    addBlock();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the contact level.');

    type('Contact level', 'light_technical');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is not added without a contact level, and says why', () => {
    const { onAdd } = setup();

    type('Kind of block', 'instruction');
    type('Title', 'Guard talk');
    type('What to say', 'Hands up.');
    addBlock();

    expect(screen.getByRole('alert')).toHaveTextContent('Not added yet. Choose the contact level. A text block has none until you choose one.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it.each(['instruction', 'demonstration', 'reset_minute', 'teaching_minute', 'conditioning', 'reflection'])(
    'a %s block is not added without words, and says why',
    (kind) => {
      const { onAdd } = setup();

      type('Kind of block', kind);
      type('Title', 'A block');
      // Only spaces and line breaks. (Words the eye cannot see are the server's to refuse: cleanAdd.)
      type('What to say', '  \n ');
      type('Contact level', 'none');
      addBlock();

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Write what to say in this block. Only Arrival, Transition and Close blocks can be left without words.',
      );
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it.each(['transition', 'arrival', 'close'])('a %s block may have no words', (kind) => {
    const { onAdd } = setup();

    type('Kind of block', kind);
    type('Title', 'Water');
    type('Contact level', 'none');
    addBlock();

    expect(onAdd).toHaveBeenCalledWith({ block_kind: kind, block_label: 'Water', text: '', contact_level: 'none' });
  });

  it('names every missing part at once: kind, title and contact level', () => {
    const { onAdd } = setup();

    addBlock();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not added yet. Choose the kind of block. The block needs a title. Choose the contact level. A text block has none until you choose one.',
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('words over the server\'s 1000 characters are not added', () => {
    const { onAdd } = setup();

    type('Kind of block', 'instruction');
    type('Title', 'Long talk');
    type('What to say', 'a'.repeat(1001));
    type('Contact level', 'none');
    addBlock();

    expect(screen.getByRole('alert')).toHaveTextContent('What to say can be 1000 characters at most.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('Enter in the title adds the block rather than submitting anything else', () => {
    const { onAdd } = setup();

    type('Kind of block', 'close');
    type('Title', 'Line up');
    type('Contact level', 'none');
    const enter = fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter' });

    expect(enter).toBe(false);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('cannot add while the editor is saving: the button is disabled and Enter adds nothing', () => {
    const onAdd = jest.fn();
    render(<TextBlockForm onAdd={onAdd} onClose={jest.fn()} disabled />);

    type('Kind of block', 'close');
    type('Title', 'Line up');
    type('Contact level', 'none');
    fireEvent.keyDown(screen.getByLabelText('Title'), { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Add this block' })).toBeDisabled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('Close hands back without adding', () => {
    const { onAdd, onClose } = setup();

    type('Title', 'Abandoned');
    fireEvent.click(screen.getByRole('button', { name: 'Close without adding' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('every control meets the gym-floor tap and type floors', () => {
    setup();

    for (const control of [...screen.getAllByRole('combobox'), screen.getByLabelText('Title'), screen.getByLabelText('What to say')]) {
      expect(control.className).toContain('input--kiosk');
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-[var(--tap)]');
      expect(button.className).toContain('text-[length:var(--t-md)]');
    }
  });
});
