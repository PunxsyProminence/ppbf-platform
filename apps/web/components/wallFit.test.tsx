/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';

import WallDisplay, { WALL_DESIGN_HEIGHT, WALL_DESIGN_WIDTH, wallFit } from './WallDisplay';

/**
 * THE BOARD FITS ITS SCREEN (issue 1792 items 1 and 2). In Jason's 1302x626 window the block strip
 * drew over NOW and the marquee over ON THE FLOOR, and the public wall did the same at about 800px:
 * the board is laid out for 1920x1080 and nothing shrank it. Now it is zoomed to fit, by the
 * shorter side, onto a canvas at least 1920x1080; at 1920x1080 and above nothing is applied, so
 * that screen is exactly as it was. The layout itself is proven in a browser (the PR's
 * screenshots); this pins the arithmetic, the style the board carries, and the CSS that makes a
 * panel clip rather than paint over its neighbour.
 */

describe('how much the board shrinks', () => {
  it('leaves 1920x1080 and anything bigger alone', () => {
    expect(wallFit(1920, 1080)).toBeNull();
    expect(wallFit(3840, 2160)).toBeNull();
    expect(wallFit(2560, 1080)).toBeNull();
  });

  it('shrinks a 16:9 window to the same board, smaller', () => {
    const fit = wallFit(1280, 720);
    expect(fit?.zoom).toBeCloseTo(2 / 3, 6);
    expect(fit?.width).toBeCloseTo(WALL_DESIGN_WIDTH, 6);
    expect(fit?.height).toBeCloseTo(WALL_DESIGN_HEIGHT, 6);
  });

  it('fits Jason\'s 1302x626 window by its height, on a wider canvas', () => {
    const fit = wallFit(1302, 626);
    expect(fit?.zoom).toBeCloseTo(626 / 1080, 6);
    expect(fit?.height).toBeCloseTo(1080, 6);
    expect(fit?.width).toBeGreaterThan(WALL_DESIGN_WIDTH);
  });

  it('fits an 800px window by its width, on a taller canvas', () => {
    const fit = wallFit(800, 600);
    expect(fit?.zoom).toBeCloseTo(800 / 1920, 6);
    expect(fit?.width).toBeCloseTo(1920, 6);
    expect(fit?.height).toBeGreaterThan(WALL_DESIGN_HEIGHT);
  });

  it('applies nothing to a window it cannot measure', () => {
    expect(wallFit(0, 0)).toBeNull();
    expect(wallFit(Number.NaN, 600)).toBeNull();
  });
});

describe('the board on the page', () => {
  const realSupports = globalThis.CSS?.supports;

  function setWindow(width: number, height: number, zoomable = true) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    (globalThis as unknown as { CSS: { supports: (p: string, v: string) => boolean } }).CSS = {
      supports: (property: string) => zoomable && property === 'zoom',
    };
  }

  beforeEach(() => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (realSupports) (globalThis as unknown as { CSS: { supports: typeof realSupports } }).CSS = { supports: realSupports };
  });

  it('carries no style at all at 1920x1080', () => {
    setWindow(1920, 1080);
    const { container } = render(<WallDisplay />);
    expect(container.querySelector('.wall-board')?.getAttribute('style')).toBeNull();
  });

  it('is laid out on a 1080-tall canvas and zoomed down in a 1302x626 window', () => {
    setWindow(1302, 626);
    const { container } = render(<WallDisplay />);
    const board = container.querySelector<HTMLElement>('.wall-board');
    expect(board?.style.height).toBe('1080px');
    expect(Number.parseFloat(board?.style.width ?? '')).toBeCloseTo(1302 / (626 / 1080), 3);
    expect(board?.style.getPropertyValue('--wall-canvas-width')).toBe(board?.style.width);
    const zoom = board?.style.getPropertyValue('zoom');
    // jsdom's style object may not know `zoom`; where it does, it is the window's share of 1080.
    if (zoom) expect(Number.parseFloat(zoom)).toBeCloseTo(626 / 1080, 4);
  });

  it('renders as it always did in a browser without zoom', () => {
    setWindow(1302, 626, false);
    const { container } = render(<WallDisplay />);
    expect(container.querySelector('.wall-board')?.getAttribute('style')).toBeNull();
  });
});

describe('a panel clips rather than painting over its neighbour', () => {
  const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  function rule(selector: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  }

  it('cuts NOW\'s words inside their own box and keeps the strip on its own row (item 1)', () => {
    expect(rule('[data-surface="wall"] .wall-now')).toMatch(/overflow:\s*hidden/);
    expect(rule('[data-surface="wall"] .wall-strip')).toMatch(/flex-shrink:\s*0/);
  });

  it('lets the gym\'s name wrap to a second line instead of an ellipsis (item 7)', () => {
    const eyebrow = rule('[data-surface="wall"] .wall-eyebrow');
    expect(eyebrow).not.toMatch(/white-space:\s*nowrap/);
    expect(eyebrow).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(eyebrow).toMatch(/-webkit-line-clamp:\s*2/);
    // Beside the round clock it holds two lines either way, so round, rest, pause and the clock's
    // digits never move the board.
    expect(rule('[data-surface="wall"] .wall-board:has(.wall-round) .wall-eyebrow')).toMatch(/min-height:\s*3em/);
  });

  it('runs a one-name marquee a canvas wide on a shrunk board', () => {
    expect(rule('.marquee-run')).toMatch(/min-width:\s*var\(--wall-canvas-width,\s*100vw\)/);
  });
});
