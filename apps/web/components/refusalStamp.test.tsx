/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';

import RefusalStamp, {
  REFUSAL_STAMP_COPY,
  TRAINING_HOLD_LABEL,
  type RefusalStampKind,
} from './RefusalStamp';

const NON_MEDICAL_KINDS: Exclude<RefusalStampKind, 'training_hold' | 'medically_not_allowed'>[] = [
  'wait',
  'get_permission',
  'wrong_door',
  'signed_out',
  'cannot_be_done',
];

describe('RefusalStamp -- the six simple stamps', () => {
  test.each(NON_MEDICAL_KINDS)('%s renders its label, glyph, and default body copy', (kind) => {
    const copy = REFUSAL_STAMP_COPY[kind];
    render(<RefusalStamp kind={kind} />);

    expect(screen.getByText(copy.label)).toBeTruthy();
    expect(screen.getByText(copy.glyph)).toBeTruthy();
    expect(screen.getByText(copy.body())).toBeTruthy();
  });

  test('WAIT appends the caller-supplied retry window rather than replacing the sentence', () => {
    render(<RefusalStamp kind="wait" detail="10 minutes" />);
    expect(screen.getByText('Too soon — try again in 10 minutes.')).toBeTruthy();
    // The plain default sentence must not also be on the page.
    expect(screen.queryByText('Too soon — try again shortly.')).toBeNull();
  });

  test('WRONG DOOR appends a destination when one is supplied', () => {
    render(<RefusalStamp kind="wrong_door" detail="return to the Coach workspace" />);
    expect(
      screen.getByText('Not available for this role — return to the Coach workspace.'),
    ).toBeTruthy();
  });

  test.each(NON_MEDICAL_KINDS)('%s announces as role="status", not role="alert"', (kind) => {
    render(<RefusalStamp kind={kind} />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('RefusalStamp -- MEDICALLY NOT ALLOWED is the one red mark', () => {
  test('renders its label, glyph, and default body copy', () => {
    const copy = REFUSAL_STAMP_COPY.medically_not_allowed;
    render(<RefusalStamp kind="medically_not_allowed" />);

    expect(screen.getByText(copy.label)).toBeTruthy();
    expect(screen.getByText(copy.glyph)).toBeTruthy();
    expect(screen.getByText(copy.body())).toBeTruthy();
  });

  test('announces as role="alert", the one kind that does', () => {
    render(<RefusalStamp kind="medically_not_allowed" />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  test('is the only kind whose mark carries the bare "stamp" class without stamp--brass', () => {
    const { container } = render(<RefusalStamp kind="medically_not_allowed" />);
    const mark = container.querySelector('.stamp');
    expect(mark).not.toBeNull();
    expect(mark?.classList.contains('stamp--brass')).toBe(false);
  });

  test.each(NON_MEDICAL_KINDS)(
    'every other simple stamp (%s) carries stamp--brass, never the bare red mark',
    (kind) => {
      const { container } = render(<RefusalStamp kind={kind} />);
      const mark = container.querySelector('.stamp');
      expect(mark?.classList.contains('stamp--brass')).toBe(true);
    },
  );
});

describe('RefusalStamp -- TRAINING HOLD is a filled record, never a blank form', () => {
  const filled = {
    kind: 'training_hold' as const,
    coachExplanation: 'Wait until the ankle is fully weight-bearing before live rounds again.',
    coachName: 'Coach Neale',
    endsWhen: 'Cleared by Coach Neale after a pain-free warmup.',
  };

  test('renders the real coach explanation, coach name, and ends-when text', () => {
    render(<RefusalStamp {...filled} />);

    expect(screen.getByText(TRAINING_HOLD_LABEL)).toBeTruthy();
    expect(screen.getByText(filled.coachExplanation)).toBeTruthy();
    expect(screen.getByText(filled.coachName)).toBeTruthy();
    expect(screen.getByText(filled.endsWhen)).toBeTruthy();
  });

  test('carries the brass, flat, non-punitive mark -- never red, never tilted', () => {
    const { container } = render(<RefusalStamp {...filled} />);
    const mark = container.querySelector('.stamp');
    expect(mark?.classList.contains('stamp--brass')).toBe(true);
    expect(mark?.classList.contains('stamp--flat')).toBe(true);
  });

  test('says explicitly that this is not a punishment', () => {
    render(<RefusalStamp {...filled} />);
    expect(screen.getByText(/not a punishment/i)).toBeTruthy();
  });

  test('throws rather than rendering a blank hold when coachExplanation is empty', () => {
    expect(() =>
      render(<RefusalStamp {...filled} coachExplanation="" />),
    ).toThrow(/real coachExplanation, coachName, and endsWhen/);
  });

  test('throws when coachName is empty -- a placeholder name is not real data', () => {
    expect(() => render(<RefusalStamp {...filled} coachName="" />)).toThrow();
  });

  test('throws when coachName is only whitespace', () => {
    expect(() => render(<RefusalStamp {...filled} coachName="   " />)).toThrow();
  });

  test('throws when endsWhen is empty', () => {
    expect(() => render(<RefusalStamp {...filled} endsWhen="" />)).toThrow();
  });
});

describe('RefusalStamp -- kiosk sizing (Law 5)', () => {
  test('every simple stamp mark carries the kiosk-scale class', () => {
    for (const kind of [...NON_MEDICAL_KINDS, 'medically_not_allowed' as const]) {
      const { container, unmount } = render(<RefusalStamp kind={kind} />);
      const mark = container.querySelector('.stamp');
      expect(mark?.classList.contains('stamp--kiosk')).toBe(true);
      unmount();
    }
  });

  test('the training hold mark also carries the kiosk-scale class', () => {
    const { container } = render(
      <RefusalStamp
        kind="training_hold"
        coachExplanation="Wait until the ankle is fully weight-bearing before live rounds again."
        coachName="Coach Neale"
        endsWhen="Cleared by Coach Neale after a pain-free warmup."
      />,
    );
    const mark = container.querySelector('.stamp');
    expect(mark?.classList.contains('stamp--kiosk')).toBe(true);
  });
});
