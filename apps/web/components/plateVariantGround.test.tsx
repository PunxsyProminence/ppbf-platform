/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import PlateVariantGround from './PlateVariantGround';
import { PLATE_VARIANT_ATTRIBUTE, plateVariantTokens } from './plateVariant';

/**
 * THE MARKER AND THE SHEET ARE TWO HALVES, AND EITHER ONE ALONE DOES NOTHING.
 *
 * kioskTapFloor.test.tsx and wallSurface.test.tsx were both written for this
 * shape of bug: a stylesheet block keyed on an attribute, and a component that
 * is supposed to put that attribute on the subtree. Each half compiles, reviews
 * cleanly, and is invisible when the other is missing. plateVariant.test.ts
 * holds the sheet's half; this file holds the DOM's.
 *
 * It also pins the two properties the whole mechanism rests on and that a
 * reader cannot see from the component alone: the marker generates no box, so
 * the branch can promise zero visual change, and it is an ANCESTOR of what it
 * marks rather than the marked element itself -- which is the only reason the
 * 73 pages that paint their own room class need no edit.
 */

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(() => '/dashboard'),
}));

const mockPathname = usePathname as unknown as jest.Mock;

const LAYOUT = readFileSync(join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');

describe('the plate variant marker', () => {
  beforeEach(() => mockPathname.mockReturnValue('/dashboard'));

  it('writes the route it is standing on', () => {
    const { container } = render(<PlateVariantGround><main className="room room--office" /></PlateVariantGround>);
    const marker = container.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`);
    expect(marker?.getAttribute(PLATE_VARIANT_ATTRIBUTE)).toBe(plateVariantTokens('/dashboard'));
  });

  it('stands above the room rather than on it', () => {
    // The room element must NOT carry the attribute: a ground the room sits
    // under is what lets one component cover the 73 server pages that paint
    // their own room class and cannot know their own route.
    const { container } = render(<PlateVariantGround><main className="room room--office" /></PlateVariantGround>);
    const marker = container.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`) as HTMLElement;
    const room = container.querySelector('.room--office') as HTMLElement;
    expect(marker.contains(room)).toBe(true);
    expect(room.hasAttribute(PLATE_VARIANT_ATTRIBUTE)).toBe(false);
  });

  it('adds no box to the page it marks', () => {
    // display: contents, the same reason app/athlete/layout.tsx gives for its
    // own marker. Without it every surface in the building would gain a
    // container it was not designed inside, and "zero visual change" would be
    // a claim rather than a fact.
    const { container } = render(<PlateVariantGround><span /></PlateVariantGround>);
    const marker = container.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`) as HTMLElement;
    expect(marker.className).toBe('contents');
  });

  it('gives the same route the same wall on every render', () => {
    const first = render(<PlateVariantGround><span /></PlateVariantGround>);
    const second = render(<PlateVariantGround><span /></PlateVariantGround>);
    const read = (host: HTMLElement) =>
      host.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`)?.getAttribute(PLATE_VARIANT_ATTRIBUTE);
    expect(read(second.container)).toBe(read(first.container));
  });

  it('gives a different route a different wall', () => {
    const read = () => {
      const { container } = render(<PlateVariantGround><span /></PlateVariantGround>);
      return container.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`)?.getAttribute(PLATE_VARIANT_ATTRIBUTE);
    };
    mockPathname.mockReturnValue('/coach/review-queue');
    const coach = read();
    mockPathname.mockReturnValue('/admin/athletes');
    expect(read()).not.toBe(coach);
  });

  it('marks nothing at all when there is no route', () => {
    // Outside a router there is no route to derive from, so the attribute is
    // absent and every room falls back to its -01 declaration. Degradation by
    // doing nothing, rather than by handling an error.
    mockPathname.mockReturnValue(null);
    const { container } = render(<PlateVariantGround><span /></PlateVariantGround>);
    expect(container.querySelector(`[${PLATE_VARIANT_ATTRIBUTE}]`)).toBeNull();
  });
});

describe('the marker is mounted where it can see every room', () => {
  it('wraps the whole app in the root layout', () => {
    // One place, above everything: the header, the children, and therefore all
    // 78 surfaces that paint a room class of their own.
    expect(LAYOUT).toContain('<PlateVariantGround>');
    expect(LAYOUT).toContain('import PlateVariantGround from "@/components/PlateVariantGround"');
    const opened = LAYOUT.indexOf('<PlateVariantGround>');
    const closed = LAYOUT.indexOf('</PlateVariantGround>');
    expect(opened).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(opened);
    expect(LAYOUT.slice(opened, closed)).toContain('{children}');
  });
});
