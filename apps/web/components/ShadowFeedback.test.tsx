/**
 * @jest-environment jsdom
 */

/**
 * WHAT RATING AN ANSWER USED TO COST.
 *
 * The old block rendered under every SHADOW bubble -- the welcome included,
 * where it could only ever sit there disabled -- and it opened with a
 * three-row textarea labelled "Reason — required". Saying "yes, that helped"
 * meant writing a paragraph first, because sendFeedback returned early
 * without one. The server never asked for it: POST
 * /api/pilot/shadow/feedback wants `helpful` and a durable `message_id`, and
 * treats `comment` as optional.
 *
 * So: nothing on an answer that cannot carry a rating; one action for yes;
 * a reason only when the answer is no.
 */

import { fireEvent, render, screen } from '@testing-library/react';

import ShadowFeedback, { encodeFeedbackComment, SHADOW_FEEDBACK_REASONS } from './ShadowFeedback';

function renderFeedback(overrides: Partial<Parameters<typeof ShadowFeedback>[0]> = {}) {
  const onSubmit = jest.fn();
  render(
    <ShadowFeedback
      messageId="msg-1"
      eligible
      sent={false}
      submitting={false}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return onSubmit;
}

test('an answer that cannot be rated shows no controls at all', () => {
  const { container } = render(
    <ShadowFeedback
      messageId="0"
      eligible={false}
      sent={false}
      submitting={false}
      onSubmit={jest.fn()}
    />,
  );

  expect(container.firstChild).toBeNull();
});

test('positive feedback is one action and carries no comment', () => {
  const onSubmit = renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith(true);
});

test('negative feedback asks for a reason and will not send without one', () => {
  const onSubmit = renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));

  // Nothing was sent by opening the reasons.
  expect(onSubmit).not.toHaveBeenCalled();
  const send = screen.getByRole('button', { name: 'Send feedback' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);

  for (const reason of SHADOW_FEEDBACK_REASONS) {
    expect(screen.getByRole('button', { name: reason.label })).toBeTruthy();
  }
});

test('a reason plus optional detail submits in two steps', () => {
  const onSubmit = renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Missing information' }));
  fireEvent.change(screen.getByLabelText('Anything else? Optional.'), {
    target: { value: 'Nothing about the left hand.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

  expect(onSubmit).toHaveBeenCalledWith(false, '[reason:missing_information] Nothing about the left hand.');
});

test('the detail field really is optional', () => {
  const onSubmit = renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Safety concern' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

  expect(onSubmit).toHaveBeenCalledWith(false, '[reason:safety_concern]');
});

test('the chosen reason is announced as pressed, not just coloured', () => {
  renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unclear' }));

  expect(screen.getByRole('button', { name: 'Unclear' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: 'Incorrect' }).getAttribute('aria-pressed')).toBe('false');
});

test('Back returns to the question without sending anything', () => {
  const onSubmit = renderFeedback();

  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));

  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
});

test('a recorded rating replaces the controls with a spoken confirmation', () => {
  renderFeedback({ sent: true });

  expect(screen.getByRole('status').textContent).toBe('Feedback recorded.');
  expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();
});

/* A failed rating used to be reported by the session notice at the top of the
   surface, above the saved-sessions list -- so the visible consequence of a
   click that failed was nothing moving. */
test('a failure is reported at the control that failed', () => {
  renderFeedback({ error: 'SHADOW could not record that feedback.' });

  expect(screen.getByRole('alert').textContent).toBe('SHADOW could not record that feedback.');
  // And the controls stay, so the person can try again.
  expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
});

/* The reason code rides `comment`, never `outcome_signal`. The human review
   queue filters on the derived signal vocabulary
   ('thumbs_up' | 'thumbs_down' | ...); a code smuggled into that column would
   make the row permanently unapprovable. */
test('the reason code is encoded into the comment in a stable shape', () => {
  expect(encodeFeedbackComment('incorrect', '  spaced  ')).toBe('[reason:incorrect] spaced');
  expect(encodeFeedbackComment('unclear', '')).toBe('[reason:unclear]');
});

test('no medals, and no implementation jargon on a surface a child can reach', () => {
  renderFeedback();
  fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));

  expect(document.body.textContent).not.toMatch(/[\u{1F44D}\u{1F44E}]/u);
  expect(document.body.textContent).not.toMatch(/RLHF/);
});
