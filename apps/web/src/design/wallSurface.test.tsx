/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import WallLayout from '../../app/wall/layout';
import GlobalRoleHeader from '../../components/GlobalRoleHeader';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * The global session bar has to stand down on /wall: it is four controls on a
 * screen with no pointer attached, and a fixed high-contrast band sitting in
 * the same pixels for twelve hours.
 *
 * The session snapshot is a MODULE-LEVEL CONSTANT, not a fresh object per call.
 * useSyncExternalStore compares snapshots by identity, so a mock that builds a
 * new object each time re-renders forever and fails with "Maximum update depth
 * exceeded" rather than anything to do with this feature.
 */
jest.mock('next/navigation', () => ({
  usePathname: jest.fn(() => '/dashboard'),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

jest.mock('../../components/roleSession', () => {
  const snapshot = { role: 'admin', expiresAt: 4102444800000 };
  return {
    getRoleSessionSnapshot: () => snapshot,
    subscribeRoleSession: () => () => {},
    clearRoleSession: jest.fn(),
  };
});

const mockPathname = usePathname as unknown as jest.Mock;

/**
 * The wall has the same two-halves problem kioskTapFloor.test.tsx was written
 * for: a stylesheet block scoped to an attribute, and a marker that actually
 * puts that attribute on the subtree. Either half alone compiles, reviews
 * cleanly, and does nothing.
 *
 * It also has a third half, which is why this file exists rather than a comment
 * in the CSS. The Phase 2 roadmap states that `.marquee` "already exists in the
 * design system with zero consumers". It does not -- design-system/ppbf.css has
 * no .marquee rule of any kind. That claim is asserted here so nobody else
 * builds against a class that is a promise in a document rather than a rule in
 * a sheet.
 */

const GLOBALS = path.resolve(__dirname, '../../app/globals.css');
const DESIGN_SYSTEM = path.resolve(__dirname, '../../../../design-system/ppbf.css');
const SURFACE_ATTRIBUTE = 'data-surface';
const SURFACE_VALUE = 'wall';

describe('the wall surface', () => {
  const globals = readFileSync(GLOBALS, 'utf8');
  const designSystem = readDesignSystemCss(DESIGN_SYSTEM);

  it('marks the wall subtree with the attribute the stylesheet targets', () => {
    const { container } = render(
      <WallLayout>
        <p className="wall-name">M.R.</p>
      </WallLayout>,
    );
    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);
    expect(marker).not.toBeNull();
    expect(marker?.querySelector('.wall-name')).not.toBeNull();
  });

  it('stands the wall in a room, full bleed', () => {
    const { container } = render(<WallLayout><span /></WallLayout>);
    const marker = container.querySelector(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`) as HTMLElement;
    // A room paints a wall and hangs light on it, so unlike the kiosk marker
    // this one is a real box -- display:contents would paint nothing.
    expect(marker.className).toContain('room--floor');
    expect(marker.className).not.toContain('contents');
    expect(globals).toContain('.wall-room');
  });

  it('has a stylesheet block for the surface it marks', () => {
    expect(globals).toContain(`[${SURFACE_ATTRIBUTE}="${SURFACE_VALUE}"]`);
  });

  it('confirms .marquee was never in the design system, and is now in globals', () => {
    // Load-bearing negative: the roadmap says otherwise, and a future author
    // reading only that document would build against nothing.
    expect(designSystem).not.toMatch(/^\s*\.marquee\b/m);
    expect(globals).toMatch(/^\.marquee\s*\{/m);
    expect(globals).toContain('@keyframes marquee-travel');
  });

  it('defends against burn-in, and stands the motion down on request', () => {
    // A television showing one layout for twelve hours retains it. The drift is
    // the primary defence and the marquee's travel covers the brightest band;
    // both have to be cancellable for anyone who cannot tolerate the motion.
    expect(globals).toContain('@keyframes wall-drift');
    const reduced = globals.slice(globals.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.wall-board\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/\.marquee-track\s*\{\s*animation:\s*none/);
  });

  it('nothing else in the app claims this surface', () => {
    // The whole safety argument for writing wall-sized type into globals.css is
    // that no other element carries the attribute, so no rule here can reach
    // another page.
    const layouts = ['../../app/athlete/layout.tsx', '../../app/layout.tsx'];
    for (const file of layouts) {
      expect(readFileSync(path.resolve(__dirname, file), 'utf8')).not.toContain(`"${SURFACE_VALUE}"`);
    }
  });
});

/**
 * Wall-sized type. The φ ladder's named rungs stop at --t-5xl / --text-6xl
 * (80.9px), which is a hero size on a laptop and a BODY size fifteen feet from
 * a television. globals.css already continues the ladder with a √φ generator;
 * this pins that the wall's sizes really are up there, since the failure mode
 * -- a class that resolves to inherited body type -- is invisible in review.
 */
describe('the wall reads at distance', () => {
  const globals = readFileSync(GLOBALS, 'utf8');
  const wallBlock = globals.slice(globals.indexOf('THE WALL ==='));

  it('continues the ladder past the named rungs for the biggest elements', () => {
    for (const generated of [
      'calc(var(--t-5xl) * var(--root-phi))',
      'calc(var(--t-5xl) * var(--root-phi) * var(--root-phi))',
    ]) {
      expect(wallBlock).toContain(generated);
    }
  });

  it('sets nothing on the wall below the panel-heading rung', () => {
    // Everything on this screen is read across a room. --t-sm (15px body) and
    // --t-xs (11.8px captions) are desk sizes and have no business here.
    const sizes = [...wallBlock.matchAll(/font-size:\s*var\((--t-[a-z0-9]+)\)/g)].map((m) => m[1]);
    expect(sizes.length).toBeGreaterThan(4);
    expect(sizes).not.toContain('--t-xs');
    expect(sizes).not.toContain('--t-sm');
    expect(sizes).not.toContain('--t-md');
  });

  it('writes no raw hex anywhere in the block', () => {
    // Colour comes from the design system's ramps. rgba() shadows and light
    // pools are the system's own idiom (see .mat-leather, .room--*) and carry
    // no hue of their own.
    expect(wallBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('the global header on /wall', () => {
  it('renders nothing at all', () => {
    mockPathname.mockReturnValue('/wall');
    const { container } = render(<GlobalRoleHeader />);
    expect(container.innerHTML).toBe('');
  });

  it('still renders everywhere else', () => {
    mockPathname.mockReturnValue('/dashboard');
    const { container } = render(<GlobalRoleHeader />);
    expect(container.querySelector('header')).not.toBeNull();
  });
});
