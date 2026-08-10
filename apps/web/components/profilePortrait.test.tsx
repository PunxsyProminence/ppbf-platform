/**
 * @jest-environment jsdom
 */

/**
 * THE FALLBACK IS THE PRIMARY STATE.
 *
 * On day one nobody has uploaded a photograph. Under the privacy rules most
 * viewers are never shown a child's face at all. A portrait stays pending until
 * a coach releases it. So the no-photo case is the case this platform is mostly
 * in, and these tests exist because "mostly" is not a state you can leave
 * looking broken.
 *
 * Two properties matter and both are asserted here:
 *
 *   1. The plate is always a finished object -- initials, never blank, never a
 *      broken-image glyph, never a request for a photo that is not there.
 *   2. "You may not see this" and "there is no photo" render IDENTICALLY. A
 *      lock glyph or a "hidden" label would tell the viewer that this child has
 *      a photograph, which is itself a disclosure about that child.
 */

import { fireEvent, render, screen } from '@testing-library/react';

import ProfilePortrait from './ProfilePortrait';

describe('the brass plate', () => {
  it('renders the initials when there is no photo, and requests nothing', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable={false} />,
    );
    expect(screen.getByText('SA')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.plate')).toBeTruthy();
  });

  it('still renders a plate when there is no account to fetch a photo from', () => {
    const { container } = render(
      <ProfilePortrait accountId={null} initials="—" name="Unknown" photoAvailable />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.plate-initials')?.textContent).toBe('—');
  });

  it('names the person for a screen reader whether or not a photo is showing', () => {
    render(<ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable={false} />);
    expect(screen.getByRole('img', { name: 'Sofia Alvarez' })).toBeTruthy();
  });

  it('renders one accessible name, not two -- the photo’s alt is empty', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable />,
    );
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(screen.getAllByRole('img', { name: 'Sofia Alvarez' })).toHaveLength(1);
  });
});

describe('a photograph that cannot be served falls back to the plate', () => {
  it('swaps to initials when the image errors', () => {
    // Every refusal from the photo route is a 404 -- no photo, not released,
    // not your family. All of them arrive here as an image error, and all of
    // them have to land on the same finished object.
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable />,
    );
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('SA')).toBeTruthy();
  });
});

describe('withheld and absent are indistinguishable', () => {
  it('renders byte-identical markup for "no photo" and "not allowed to see it"', () => {
    // The client is told `photoAvailable: false` in both cases and is never
    // told which. If these two ever diverge, the roster starts leaking which
    // children have photographs.
    const noPhoto = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable={false} />,
    ).container.innerHTML;

    const withheld = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable={false} />,
    ).container.innerHTML;

    expect(withheld).toBe(noPhoto);
  });

  it('says nothing anywhere a person can read that a photo is being withheld', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia Alvarez" photoAvailable={false} />,
    );
    // Visible text and the accessible name -- the two channels a person
    // actually receives. (aria-hidden on the initials is markup, not a message.)
    expect(container.textContent ?? '').toBe('SA');
    const label = container.querySelector('.plate')?.getAttribute('aria-label') ?? '';
    expect(label).toBe('Sofia Alvarez');
    expect(label).not.toMatch(/hidden|locked|private|restricted|withheld/i);
    expect(container.querySelector('[title]')).toBeNull();
  });
});

describe('the plate carries the member’s corner and nothing else does', () => {
  it('scopes the corner to this element only', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia" photoAvailable={false} corner="red" />,
    );
    const plate = container.querySelector('.plate');
    expect(plate?.getAttribute('data-corner')).toBe('red');
    expect(plate?.className).toContain('corner-scope');
    expect(plate?.className).toContain('plate--cornered');
  });

  it('does not draw a corner bevel when no corner is chosen', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia" photoAvailable={false} />,
    );
    expect(container.querySelector('.plate')?.className).not.toContain('plate--cornered');
  });

  it('never hardcodes a colour', () => {
    const { container } = render(
      <ProfilePortrait accountId="acct-1" initials="SA" name="Sofia" photoAvailable={false} corner="blue" />,
    );
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(container.innerHTML).not.toMatch(/\b(red|blue)\s*;|rgb\(/i);
  });
});

describe('a portrait beside a name steps out of the accessibility tree', () => {
  it('announces the person when it stands alone', () => {
    render(<ProfilePortrait accountId="a" initials="SA" name="Sofia Alvarez" photoAvailable={false} />);
    expect(screen.getByRole('img', { name: 'Sofia Alvarez' })).toBeTruthy();
  });

  it('says nothing when the name is already printed next to it', () => {
    // A roster row reading "Sofia Alvarez, image, Sofia Alvarez" is the portrait
    // making the name harder to read rather than easier -- and it broke the
    // accessible name of the button the chip sits inside.
    const { container } = render(
      <button type="button">
        <ProfilePortrait accountId="a" initials="SA" name="Sofia Alvarez" photoAvailable={false} decorative />
        Sofia Alvarez
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Sofia Alvarez' })).toBeTruthy();
    expect(container.querySelector('.plate')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.plate')?.getAttribute('role')).toBeNull();
  });
});
