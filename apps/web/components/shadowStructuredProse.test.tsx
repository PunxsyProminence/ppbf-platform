/**
 * @jest-environment jsdom
 */

/**
 * WHAT A SHADOW ANSWER LOOKED LIKE BEFORE THIS.
 *
 * Every answer -- four paragraphs, a numbered progression, a list of
 * contraindications -- was rendered as `<p>{msg.text}</p>`. One paragraph.
 * The newlines the model wrote were collapsed by CSS, so a five-step return
 * protocol arrived as a single grey block and the person reading it in a gym
 * had to find step three by counting sentences.
 *
 * The split has to stay CONSERVATIVE, and these tests pin that as hard as they
 * pin the structure: no heading inference, no emphasis parsing, and above all
 * no HTML. A safety sentence guessed wrong is worse than a plain paragraph,
 * and markup built from model output is a hole in the room.
 */

import { render, screen } from '@testing-library/react';

import ShadowStructuredProse, { splitProseBlocks } from './shadowStructuredProse';

describe('splitProseBlocks', () => {
  test('blank lines separate paragraphs', () => {
    expect(splitProseBlocks('First thing.\n\nSecond thing.')).toEqual([
      { kind: 'paragraph', text: 'First thing.' },
      { kind: 'paragraph', text: 'Second thing.' },
    ]);
  });

  test('a run of dashes is a list, not five paragraphs', () => {
    expect(splitProseBlocks('Watch for:\n- dizziness\n- blurred vision\n* headache')).toEqual([
      { kind: 'paragraph', text: 'Watch for:' },
      { kind: 'bullets', items: ['dizziness', 'blurred vision', 'headache'] },
    ]);
  });

  test('a numbered progression keeps its order', () => {
    expect(splitProseBlocks('1. Rest.\n2) Light movement.\n3. Return to contact.')).toEqual([
      { kind: 'numbered', items: ['Rest.', 'Light movement.', 'Return to contact.'] },
    ]);
  });

  test('hand-wrapped lines inside one block stay one paragraph', () => {
    expect(splitProseBlocks('The guard drops in\nthe third round.')).toEqual([
      { kind: 'paragraph', text: 'The guard drops in the third round.' },
    ]);
  });

  test('CRLF from a stored row splits the same as LF', () => {
    expect(splitProseBlocks('One.\r\n\r\nTwo.')).toEqual([
      { kind: 'paragraph', text: 'One.' },
      { kind: 'paragraph', text: 'Two.' },
    ]);
  });

  test('nothing else is inferred: a hash line is prose, not a heading', () => {
    expect(splitProseBlocks('## Not a heading')).toEqual([
      { kind: 'paragraph', text: '## Not a heading' },
    ]);
  });

  test('empty and whitespace-only text produce no blocks', () => {
    expect(splitProseBlocks('')).toEqual([]);
    expect(splitProseBlocks('   \n\n  ')).toEqual([]);
  });
});

describe('ShadowStructuredProse', () => {
  test('renders paragraphs and lists as real elements', () => {
    const { container } = render(
      <ShadowStructuredProse text={'Do this:\n- one\n- two\n\nThen stop.'} />,
    );

    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(screen.getByText('Then stop.')).toBeTruthy();
  });

  /* THE ONE THAT MATTERS. The renderer takes a string straight from a model
     and must never open an HTML path with it -- no dangerouslySetInnerHTML, no
     markdown-to-HTML step that could grow one later. */
  test('markup in model output is text, never elements', () => {
    const { container } = render(
      <ShadowStructuredProse text={'<img src=x onerror="alert(1)"> and <b>bold</b>'} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  test('renders nothing at all for an empty answer', () => {
    const { container } = render(<ShadowStructuredProse text="   " />);

    expect(container.firstChild).toBeNull();
  });
});
