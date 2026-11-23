import fs from 'node:fs';
import path from 'node:path';
import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE ATHLETE ACHIEVEMENTS NOTE CARD, ON THE KIOSK (athlete) SIDE.
 *
 * Measured 2026-11-23 (Claude Science, re-measured here from main): the note
 * card was `bg-[rgba(0,0,0,.3)]` laid over the LIGHT `.pap--card` shell, so it
 * painted a grey (#A6A08F to #B0ADA4) while its ink stayed bone-100 / bone-200
 * (pale ink written for leather) and its attribution `.tcard-sub` stayed
 * --card-ink-muted (ink written for the light card). Ratios 1.81 to 2.92:1,
 * live since 2026-08-03.
 *
 * The fix puts the note card on --paper with the card inks. This file reads the
 * ground and every ink the card names out of AthleteAchievements.tsx, resolves
 * them against the real token sheet, and requires WCAG AA 4.5:1 for each pair.
 * (The type is --t-md, 19.1px: not "large text", so the 3:1 allowance is not
 * used.) Computed, not pinned: retune a token or change a class and it reruns.
 *
 * MUTATION CHECK: put `bg-[rgba(0,0,0,.3)]` back on the kiosk NOTE_CARD, or
 * `--bone-100` / `--bone-200` back on the note text, and this goes red.
 */

const SRC = fs.readFileSync(path.join(__dirname, '../../components/AthleteAchievements.tsx'), 'utf8');
const CSS = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

function token(name: string): string {
  const m = CSS.match(new RegExp(String.raw`^\s*${name}\s*:\s*(#[0-9a-fA-F]{6})\b`, 'm'));
  if (!m) throw new Error(`token ${name} not found as a #rrggbb in the sheet`);
  return m[1];
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The kiosk (non-family) branch of NOTE_CARD. */
const noteCardKiosk = SRC.match(/function NOTE_CARD[\s\S]*?:\s*'([^']+)';/)?.[1] ?? '';
/** Every token ink named by a `text-[color:var(--x)]` utility in the wall (the
    failed / empty lines and the note card), up to the MENTORSHIP block. The
    family arms use t-body / t-muted classes, so only the kiosk arms match. */
const wall = SRC.slice(SRC.indexOf('recognitionFailed ?')).split('MENTORSHIP')[0];
const noteInks = [...wall.matchAll(/text-\[color:var\((--[a-z0-9-]+)\)\]/g)].map((m) => m[1]);
/** The .pap--card shell gradient stops (design-system/legacy/ppbf-leather-brass.css
    .pap--card), the ground under the wall lines that are not on the note card. */
const SHELL_STOPS = ['#FBF7EA', '#EDE4CC'];

describe('Achievements note card contrast (kiosk side)', () => {
  it('finds the ground and the inks it is meant to check', () => {
    expect(noteCardKiosk).toMatch(/bg-\[var\(--paper\)\]/);
    expect(noteInks.length).toBeGreaterThanOrEqual(4);
  });

  it('the note card ground is an opaque token, not a tint over the shell', () => {
    expect(noteCardKiosk).not.toMatch(/rgba\(/);
  });

  it('every ink on the note card reads at 4.5:1 or better on its ground', () => {
    const grounds = [token('--paper'), ...SHELL_STOPS];
    const inks = new Set([...noteInks, '--card-ink-muted']); // + the .tcard-sub attribution
    for (const ink of inks) {
      for (const ground of grounds) {
        expect({ ink, ground, ok: contrast(token(ink), ground) >= 4.5 }).toEqual({ ink, ground, ok: true });
      }
    }
  });

  it('no leather-bone ink is left on the note card', () => {
    expect(noteInks.filter((i) => i.startsWith('--bone-'))).toEqual([]);
  });
});
