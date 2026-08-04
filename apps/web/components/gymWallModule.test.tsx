/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, fireEvent, render, screen } from '@testing-library/react';

import GymWallModule from './GymWallModule';
import PhotoSlot from './PhotoSlot';
import { GYM_PHOTO_SLOTS, type GymPhotoSlot } from '@/src/shared/gymPhotos';

/**
 * The empty wall is the state nearly everybody will see, so it is tested first
 * and hardest. The populated wall is the variant.
 */

function slot(overrides: Partial<GymPhotoSlot> = {}): GymPhotoSlot {
  return {
    key: 'ring',
    title: 'The ring',
    caption: 'Most people who train here never step in it.',
    file: null,
    alt: 'The boxing ring.',
    surfaces: ['dashboard'],
    ...overrides,
  };
}

describe('the empty frame', () => {
  it('renders a frame and a caption, and no image element at all', () => {
    const { container } = render(<PhotoSlot slot={slot()} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.photo-slot-mount')).not.toBeNull();
    expect(screen.getByText('The ring')).toBeTruthy();
    expect(screen.getByText(/never step in it/)).toBeTruthy();
  });

  it('shows nothing that reads as a failure or as work in progress', () => {
    const { container } = render(<PhotoSlot slot={slot()} />);
    const text = container.textContent ?? '';

    for (const word of ['coming soon', 'placeholder', 'loading', 'no image', 'todo', 'tbd', 'upload']) {
      expect({ word, present: text.toLowerCase().includes(word) }).toEqual({ word, present: false });
    }
    // No spinner, no skeleton: nothing is loading, there is simply no photograph.
    expect(container.querySelector('.skeleton, [role="progressbar"], .animate-spin')).toBeNull();
  });

  it('marks itself empty so a surface can lay itself out around the fact', () => {
    const { container } = render(<PhotoSlot slot={slot()} />);
    expect(container.querySelector('[data-filled="no"]')).not.toBeNull();
  });

  it('shows the photograph, with its alt text, once a file is named', () => {
    render(<PhotoSlot slot={slot({ file: 'ring.jpg' })} />);
    const image = screen.getByAltText('The boxing ring.') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/gym/ring.jpg');
  });

  it('falls back to the empty frame when a photograph fails to load', () => {
    // Indistinguishable from never having had one, on purpose: a reader must
    // not be able to infer from the layout that a picture exists.
    const { container } = render(<PhotoSlot slot={slot({ file: 'ring.jpg' })} />);
    const image = container.querySelector('img') as HTMLImageElement;

    act(() => {
      fireEvent.error(image);
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-filled="no"]')).not.toBeNull();
  });

  it('refuses a slot pointed anywhere but the static folder', () => {
    const { container } = render(<PhotoSlot slot={slot({ file: '/api/pilot/profile/photo/acct-1' })} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('the gym wall module', () => {
  it('is an empty wall today, because there are no photographs', () => {
    const { container } = render(<GymWallModule />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-filled="no"]')).not.toBeNull();
    // More than one frame: a single empty frame reads as a thing that failed,
    // a row of them reads as a wall waiting to be filled.
    expect(container.querySelectorAll('.photo-slot').length).toBeGreaterThan(1);
    expect(screen.getByText(/Nobody has taken these yet/)).toBeTruthy();
  });

  it('says out loud that no child photograph goes on a shared screen', () => {
    render(<GymWallModule />);
    expect(screen.getByText(/no pictures of anybody.s kid on a shared screen/i)).toBeTruthy();
  });

  it('offers no rotation with one photograph', () => {
    render(<GymWallModule slots={[slot({ file: 'ring.jpg' })]} rotateMs={0} />);
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });

  it('rotates by hand when there is more than one, without a timer', () => {
    render(
      <GymWallModule
        rotateMs={0}
        slots={[
          slot({ key: 'ring', file: 'ring.jpg', alt: 'The boxing ring.' }),
          slot({ key: 'bags', file: 'bags.jpg', alt: 'The heavy bags.', title: 'The bags' }),
        ]}
      />,
    );

    expect(screen.getByAltText('The boxing ring.')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    });

    expect(screen.getByAltText('The heavy bags.')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('wraps at both ends', () => {
    render(
      <GymWallModule
        rotateMs={0}
        slots={[
          slot({ key: 'ring', file: 'ring.jpg', alt: 'The boxing ring.' }),
          slot({ key: 'bags', file: 'bags.jpg', alt: 'The heavy bags.' }),
        ]}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    });
    expect(screen.getByAltText('The heavy bags.')).toBeTruthy();
  });

  it('skips the empty slots when only some are filled', () => {
    render(
      <GymWallModule
        rotateMs={0}
        slots={[slot({ key: 'empty-one' }), slot({ key: 'ring', file: 'ring.jpg', alt: 'The boxing ring.' })]}
      />,
    );

    expect(screen.getByAltText('The boxing ring.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });

  it('draws only from the static manifest, never from member media', () => {
    // The privacy boundary as source. A dashboard module is a wider audience
    // than a profile page, and profileVisibility.ts refuses a minor's face to
    // that audience -- so there must be no path from here to the portrait
    // pipeline for anybody to widen later.
    const source = readFileSync(path.join(__dirname, 'GymWallModule.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    for (const forbidden of ['portraitUrl', 'profile/photo', 'account_profiles', 'ProfilePortrait', 'athlete_id']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it('asks the manifest for dashboard slots, which exclude the front door', () => {
    const { container } = render(<GymWallModule />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('The front door');
    expect(GYM_PHOTO_SLOTS.some((entry) => entry.key === 'entrance')).toBe(true);
  });
});
