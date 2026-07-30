# PPBF Brand & Visual Design Brief

A single, copy-paste-ready reference for generating **on-brand custom visuals**
(with Canvas or any design/image tool) that match the shipped PPBF web app.

> **Source of truth = the code.** These values are extracted from the *live*
> implementation, not from prose. When anything conflicts, `apps/web/app/globals.css`
> and `apps/web/components/uiStyles.ts` win.
>
> ⚠️ **`docs/FRONTEND_STYLE_CONTRACT.md` is stale.** It describes an old *dark*
> theme (`#0a0a0a` background, tan accent `#d4a574`). The app now ships a
> **light tan "tactical" theme**. Use the values in this brief, not that contract.

---

## 1. The organization

- **Name:** Punxsy Prominence Boxing & Fitness (PPBF)
- **Type:** IRS-recognized 501(c)(3) nonprofit; youth boxing & athlete development
- **Where:** Punxsutawney and rural western Pennsylvania
- **Cost to families:** Free — children participate at no charge
- **Founder / Head Coach / Governor:** Jason Neale
- **Tagline in use:** *"Boxing is the engagement platform. Youth development is the objective."*
- **Voice:** disciplined, safety-first, governance-forward, plain-spoken. Not hype.

## 2. The aesthetic (read this first)

A **tactical / military field-manual / brutalist** look:

- Canvas-tan "paper" background with a subtle noise grain
- Thick black borders and square panels
- **Hard, blur-free offset drop shadows** (the single most recognizable trait)
- Condensed stencil headings; mono uppercase micro-labels
- **Blood red** is the only accent color — used sparingly for actions & alerts

Avoid: glossy gradients, soft blurred shadows, rounded "friendly SaaS" cards,
slate/emerald/cyan/blue theme fragments, drop-shadow blur.

## 3. Color palette (exact)

| Role | Token | Hex |
|---|---|---|
| Background (paper) | `--canvas-tan` | `#d4c4a8` |
| Light surface | `--canvas-tan-light` | `#e5d9c3` |
| Dark surface / muted btn | `--canvas-tan-dark` | `#8b7355` |
| Primary text & borders | `--black` | `#1a1a1a` |
| Dark panel bg | `--gray-dark` | `#2a2a2a` |
| Muted text | `--gray-medium` | `#4a4a4a` |
| Olive (hover fill) | `--olive-dark` | `#3d3d2e` |
| Off-white text | `--white` | `#f5f5f5` |
| Off-white 2 | `--white-off` | `#e8e8e8` |
| **Accent — primary** | `--red-primary` | `#8b0000` |
| Accent — hover | `--red-highlight` | `#a52a2a` |
| Accent — deep | `--red-blood` | `#660000` |
| Status — ready/success | `--status-ready` | `#4a5d23` |
| Status — warning | `--status-warning` | `#8b6914` |
| Status — critical | `--status-critical` | `#8b0000` |
| Status — inactive | `--status-inactive` | `#4a4a4a` |

## 4. Typography

| Use | Font | Fallbacks | Notes |
|---|---|---|---|
| Headings, buttons ("stencil") | **Oswald** (400/500/700) | Impact, Arial Black | condensed; tracking 1–2px; tight leading 1.2 |
| Body | **Roboto Condensed** (400/700) | Segoe UI, Arial Narrow | leading 1.5 |
| Mono / chips / micro-labels | **Geist Mono** | Courier New | UPPERCASE, letter-spacing up to 0.35em |

Type scale (px): 11, 12, 15 (base), 16, 18, 24, 32, 48.

## 5. Signature treatments (reproduce these exactly)

- **Offset shadows (no blur):**
  - sm `2px 2px 0 rgba(0,0,0,.3)`
  - md `4px 4px 0 rgba(0,0,0,.4)`
  - lg `6px 6px 0 rgba(0,0,0,.5)`
- **Borders:** solid `#1a1a1a`; thin 1px / medium 2px / thick 3px. Panels & headers use 2–3px.
- **Paper grain overlay:** fractal-noise SVG, `opacity: 0.06`, fixed over the whole page.
- **Corners:** square by default. Only exception: pill (`rounded-full`) CTA buttons on the marketing hero.
- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32.
- **Focus state:** 2px solid `#8b0000` outline, 2px offset. Min touch target 44px.

## 6. Core components

- **Panel** — tan bg, 2px black border, `shadow-sm`. Dark variant: `--gray-dark` bg, off-white text.
- **Chip** — `--canvas-tan-light` bg, 1px black border, mono uppercase, 11px. Critical variant: red bg, white text.
- **Button** — stencil uppercase, `--canvas-tan-dark` bg, 2px black border, `shadow-sm`; hover fills `--olive-dark` with white text. Critical variant: red bg → red-highlight hover.
- **Tabs / mode buttons** — active = red bg + tan-light text; inactive = tan-light bg + gray text, hover darkens.
- **Header** — sticky, 3px black bottom border, `--canvas-tan-dark` bg, mono uppercase labels, red role badge.

## 7. Ready-made prompt for Canvas / image tools

> Create a [poster / social card / flyer] for **Punxsy Prominence Boxing & Fitness**,
> a nonprofit youth boxing program. Use a **tactical military field-manual aesthetic**:
> canvas-tan paper background `#d4c4a8` with a faint noise grain; thick 2–3px solid
> black `#1a1a1a` borders on square panels; **hard blur-free offset drop shadows**
> (e.g. `4px 4px 0` black). Headlines in a condensed stencil font (Oswald / Impact),
> uppercase with wide letter-spacing; body in Roboto Condensed; tiny mono uppercase
> tag labels. Single accent color: **blood red `#8b0000`** (hover `#a52a2a`) used only
> for the primary call-to-action and alerts. Olive-green `#4a5d23` = success, mustard
> `#8b6914` = warning. Keep it disciplined and safety-forward, not glossy. No rounded
> cards, no gradients, no blue/cyan.

## 8. Known gaps / to supply

- **No logo asset in the repo** — `public/` contains only default Next.js SVGs.
  Provide a wordmark/mark, or have Canvas propose one in the stencil style.
- **Undefined status vars:** `uiStyles.ts` references `--status-danger` and
  `--status-info`, but `globals.css` defines `--status-critical` (and no info/blue).
  Those badges render colorless until the tokens are reconciled.

## References
- `apps/web/app/globals.css` — palette, type, component classes
- `apps/web/components/uiStyles.ts` — tokenized Tailwind class registry
- `apps/web/app/layout.tsx` — font wiring (Oswald / Roboto Condensed / Geist Mono)
- `apps/web/app/page.tsx` — marketing hero (canonical example of the look)
