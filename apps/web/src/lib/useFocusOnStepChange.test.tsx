/**
 * @jest-environment jsdom
 */

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { useFocusOnStepChange } from './useFocusOnStepChange';

function Wizard() {
  const [step, setStep] = useState(1);
  useFocusOnStepChange(`step-${step}-heading`);
  return (
    <div>
      <h2 id="step-1-heading" tabIndex={-1}>Step One</h2>
      <h2 id="step-2-heading" tabIndex={-1}>Step Two</h2>
      <button type="button" onClick={() => setStep(2)}>
        Next
      </button>
    </div>
  );
}

describe('useFocusOnStepChange', () => {
  test('focuses the initial step heading on mount', () => {
    render(<Wizard />);
    expect(document.activeElement).toBe(screen.getByText('Step One'));
  });

  test('moves focus to the new step heading when the step changes', () => {
    render(<Wizard />);
    fireEvent.click(screen.getByText('Next'));

    expect(document.activeElement).toBe(screen.getByText('Step Two'));
  });
});
