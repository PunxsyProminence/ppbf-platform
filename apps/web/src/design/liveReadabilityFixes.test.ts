import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * TWO READABILITY FAULTS FOUND LIVE AFTER RELEASE 0a9b2972 (research findings
 * F-1 and A-6, 2026-11-22). The third, the coach home "(open)" word (F-2), is
 * guarded in components/coachWorkspaceHonesty.test.tsx, where the tab renders.
 *
 * This reads the stylesheets and computes WCAG 2.x contrast from their colour
 * values. It is not a rendered page: grain textures and blending are not
 * counted, so the ratios are the flat-colour figures.
 */

const DESIGN = path.resolve(__dirname, '../../../../design-system');
const LEGACY = readFileSync(path.join(DESIGN, 'legacy/ppbf-leather-brass.css'), 'utf8');
const THEME = readFileSync(path.join(DESIGN, 'current/ppbf-golden-era.css'), 'utf8');

type Rgb = [number, number, number];

function rules(sheet: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  // Comments out, and `@import ...;` statements too: the legacy sheet imports
  // its fonts right above :root, which would otherwise glue onto that selector.
  const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: match[1].split(',').map((part) => part.trim().replace(/\s+/g, ' ')), body: match[2] });
  }
  return out;
}

/** The declarations of the first rule whose selector list names `selector`. */
function ruleFor(sheet: string, selector: string): string {
  const found = rules(sheet).find((rule) => rule.selectors.includes(selector));
  if (!found) throw new Error(`no rule names ${selector}`);
  return found.body;
}

/** A custom property's hex value, from the first rule (in `sheet`) that declares it. */
function token(body: string, name: string): Rgb {
  const match = body.match(new RegExp(`${name}\\s*:\\s*#([0-9a-fA-F]{6})`));
  if (!match) throw new Error(`no hex value for ${name}`);
  return hex(match[1]);
}

function hex(value: string): Rgb {
  const h = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

/** color-mix(in srgb, a p%, b): straight interpolation of the encoded channels. */
function mix(a: Rgb, b: Rgb, p: number): Rgb {
  return a.map((v, i) => Math.round(v * p + b[i] * (1 - p))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const ROOT = rules(LEGACY).find((rule) => rule.selectors.includes(':root') && /--canvas-warm\s*:/.test(rule.body))!.body;

describe('F-1: a status badge on a cream page reads at 4.5:1', () => {
  const badge = ruleFor(LEGACY, '.on-canvas .badge');
  const ink = Number(badge.match(/(?<![-\w])color:\s*color-mix\(in srgb, var\(--badge\) (\d+)%, #241B12\)/)![1]) / 100;
  const tint = Number(badge.match(/background-color:\s*color-mix\(in srgb, var\(--badge\) (\d+)%, var\(--canvas-warm\)\)/)![1]) / 100;
  const canvas = token(ROOT, '--canvas-warm');

  // At the old 80% ink: cleared 4.00, monitor 4.33, restricted 3.67 (all
  // under), locked 5.10, filed 4.52. At 55%: 5.55, 5.83, 5.21, 6.49, 5.99.
  test.each(['--cleared', '--monitor', '--restricted', '--locked', '--filed'])('%s', (name) => {
    const status = token(ROOT, name);
    const ratio = contrast(mix(status, hex('#241B12'), ink), mix(status, canvas, tint));
    // 11px bold is not large text, so AA asks 4.5:1.
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe('A-6: the athlete room keeps its pale nameplate eyebrow off paper', () => {
  test('no bare `.ge-locker .t-eyebrow` rule paints paper panels', () => {
    const selectors = rules(THEME).flatMap((rule) => rule.selectors);
    expect(selectors).not.toContain('.ge-locker .t-eyebrow');
    expect(selectors).toContain('.ge-locker .t-eyebrow:not(:where(.mat-paper) *)');
  });

  test('on paper the eyebrow takes the room\'s dark brass, at 4.5:1 or better', () => {
    expect(ruleFor(LEGACY, '.mat-paper .t-eyebrow')).toMatch(/color:\s*var\(--brass-800\)/);
    const locker = rules(THEME).find((rule) => rule.selectors.includes('.ge-locker') && /--brass-800\s*:/.test(rule.body))!;
    const ink = token(locker.body, '--brass-800');
    // The paper's gradient stops (.mat-paper) and its flat --paper.
    for (const ground of ['#F8F0DC', '#E7DBBD', '#F4EBD4']) {
      expect(contrast(ink, hex(ground))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
