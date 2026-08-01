# PPBF Retro Golden-Era Design System

**Version:** 1.0  
**Codename:** Poor Man's Sport  
**Status:** ⚠️ **SUPERSEDED — do not build from Section 1 or 2.**  
**Companion docs:** `USABILITY_SPEC_RETRO.md`, `STAMP_AND_LEDGER_SCHEMA.md`, `FLOOR_FLOWS_SPARRING_ATTENDANCE.md`

> **This was the proposal. [design-system/ppbf.css](../design-system/ppbf.css) is
> what shipped**, and it is the single source of truth for every token, material,
> and component class. This document's Section 1 tokens and Section 2 components are
> superseded — the shipped values are different, and copying from here reintroduces
> a palette the app no longer uses.
>
> Two specific things here are **wrong about the shipped app**:
>
> - Section 1 scopes its tokens to `[data-theme="retro"]` "so the existing tactical
>   theme can coexist." There is deliberately **no second palette and no
>   `[data-theme]` override** — one look, the golden-era one. What varies per surface
>   is the *ground* (ink vs. warm canvas, Law 6), which is a material choice, not a
>   user-facing theme toggle.
> - Its `--stamp-*` and `--brass*` names survive in `globals.css` only as **aliases**
>   pointed at design-system values. The hexes in this document are dead.
>
> Kept unarchived because the *thinking* — physical-object controls, the stamp
> vocabulary, floor-use ergonomics — is what the Eight Laws were built from, and
> because the three companion docs depend on it for that reasoning. Read it as
> rationale, not as spec. For anything buildable, use
> [design-system/README.md](../design-system/README.md) and
> [FRONTEND_STYLE_CONTRACT.md](FRONTEND_STYLE_CONTRACT.md).

This document defines the complete visual and component language for the 1930s–1950s neighborhood boxing gym interface.

---

## 1. Design Tokens (CSS Variables)

Add these to `:root` (or a dedicated `[data-theme="retro"]` scope so the existing tactical theme can coexist).

```css
:root, [data-theme="retro"] {
  /* Paper & surfaces */
  --paper:            #e8d9c0;          /* aged yellowed newsprint */
  --paper-deep:       #d4c4a8;          /* darker paper panels */
  --paper-grain:      rgba(0,0,0,0.06); /* overlay noise */
  --ink:              #1a120b;          /* near-black typewriter ink */
  --ink-muted:        #3d2e22;          /* secondary text */

  /* Leather & wood */
  --leather:          #3b2415;
  --leather-light:    #5c3a24;
  --mahogany:         #2c1810;
  --mahogany-border:  #1a0f0a;

  /* Brass */
  --brass:            #b08d57;
  --brass-light:      #d4af77;
  --brass-dark:       #8a6a3c;
  --brass-text:       #1a120b;

  /* Stamps (status language) */
  --stamp-cleared:    #4a5c2e;          /* olive green */
  --stamp-hold:       #a67c2d;          /* amber */
  --stamp-restricted: #8b0000;          /* deep crimson */
  --stamp-present:    #2e4a3e;          /* dark teal-green */
  --stamp-neutral:    #4a3c2e;          /* brown */

  /* Shadows (hard, blur-free — Law of the gym desk) */
  --shadow-hard:      4px 4px 0 #1a120b;
  --shadow-hard-lg:   6px 6px 0 #1a120b;
  --shadow-pressed:   1px 1px 0 #1a120b;

  /* Borders */
  --border-thick:     3px solid var(--ink);
  --border-brass:     2px solid var(--brass-dark);

  /* Typography */
  --font-display:     "Oswald", "Anton", "Impact", sans-serif; /* wood-type / stencil */
  --font-slab:        "Roboto Slab", "Courier New", serif;
  --font-mono:        "Special Elite", "Courier Prime", "Courier New", monospace; /* typewriter */
  --font-body:        "Roboto Condensed", "Arial Narrow", sans-serif;

  /* Spacing & radii (almost none) */
  --radius-none:      0;
  --radius-sm:        2px;              /* only for very small badges */
  --space-ticket:     12px;
  --space-board:      20px;
}
```

### Usage notes
- Never use soft box-shadows or blur.
- Paper grain is applied via `background-image` or a fixed pseudo-element with `mix-blend-mode: multiply` and low opacity.
- All interactive elements use the hard offset shadow; on `:active` the shadow becomes `--shadow-pressed` (mechanical press feel).

---

## 2. Core Components

### 2.1 `.stamp`
Primary status and action language.

```html
<button class="stamp stamp--cleared">CLEARED</button>
<button class="stamp stamp--hold">HOLD</button>
<button class="stamp stamp--restricted">RESTRICTED</button>
<button class="stamp stamp--present">PRESENT</button>
<span class="stamp stamp--static stamp--cleared">CLEARED</span> <!-- read-only -->
```

**Rules**
- Minimum size: 48×48 px (floor use: 56–64 px).
- Font: `--font-display`, uppercase, tracking 0.05em.
- Background: the stamp color; text: `#f5e6c8` or pure white.
- Border: 2 px solid darker variant of the stamp color.
- On press: translate(1px,1px) + `--shadow-pressed`.
- Destructive stamps (RESTRICTED, ESCALATE) require 300 ms press-and-hold or confirmation plate on floor devices.

### 2.2 `.brass-plate`
Secondary actions and nameplates.

```html
<button class="brass-plate">START ROUND</button>
<div class="brass-plate brass-plate--label">STAFF: 12</div>
```

**Rules**
- Background: linear gradient or flat `--brass` → `--brass-light`.
- Text: `--brass-text` (ink).
- Hard shadow + 2 px brass border.
- Height ≥ 44 px.

### 2.3 `.leather-tag`
Navigation rail / role badges.

```html
<nav class="leather-rail">
  <a class="leather-tag is-active" href="/coach/review-queue">Review Queue</a>
  <a class="leather-tag" href="/coach/decision-loop">Decision Loop</a>
</nav>
```

**Rules**
- Background: `--leather`.
- Text: `--paper`.
- Active state: crimson underline or brass rivet indicator.
- Desktop: vertical left rail. Mobile: bottom tab bar (same class).

### 2.4 `.paper-ticket`
Content unit (cases, athletes, notes).

```html
<article class="paper-ticket">
  <header class="paper-ticket__head">
    <span class="paper-ticket__id">#47</span>
    <span class="stamp stamp--static stamp--hold">HOLD</span>
  </header>
  <div class="paper-ticket__body">
    <h3>J. Rivera · 14 · Sparring video</h3>
    <p class="mono">Submitted 14:08 · Coach M.</p>
  </div>
  <footer class="paper-ticket__actions">
    <button class="stamp stamp--cleared">CLEARED</button>
    <button class="stamp stamp--hold">HOLD</button>
    <button class="stamp stamp--restricted">ESCALATE</button>
  </footer>
</article>
```

**Rules**
- Background: `--paper`.
- Border: `--border-thick`.
- Shadow: `--shadow-hard`.
- On open: expands or becomes drawer while keeping paper texture.

### 2.5 `.ledger-tape`
Append-only activity / audit / chat.

```html
<div class="ledger-tape" role="log" aria-live="polite">
  <div class="ledger-tape__edge ledger-tape__edge--top"></div>
  <ol class="ledger-tape__entries">
    <li><time>14:22</time> COACH M. STAMPED CLEARED Case #47</li>
    <li><time>14:19</time> SYSTEM SYNCED 3 pending stamps</li>
  </ol>
  <div class="ledger-tape__edge ledger-tape__edge--bottom"></div>
</div>
```

**Rules**
- Mono font, continuous vertical scroll.
- Perforated top/bottom edges (CSS repeating linear-gradient or SVG).
- New entries appear at the bottom (or top — choose one and stay consistent).
- Never editable after write.

### 2.6 `.brass-scoreboard`
Persistent KPI / health bar.

```html
<div class="brass-scoreboard" role="status">
  <span>OPEN: 7</span>
  <span class="sep">│</span>
  <span>HOLD: 2</span>
  <span class="sep">│</span>
  <span>CLEARED TODAY: 11</span>
  <span class="stamp stamp--static stamp--cleared">COMPLIANCE GREEN</span>
</div>
```

Always visible at the top of every authenticated page.

### 2.7 `.mechanical-lock`
PIN entry.

```html
<div class="mechanical-lock">
  <div class="mechanical-lock__display">••••</div>
  <div class="mechanical-lock__keys">
    <button>1</button> … <button>0</button>
  </div>
  <button class="brass-plate">ENTER</button>
</div>
```

Keys ≥ 56 px. Optional click sound / haptic.

### 2.8 `.passbook-card`
Athlete / parent simplified view.

Large paper card with photo placeholder, name, current stamps, next session, and 1–3 big stamps only.

### 2.9 `.gym-locker-tile`
Used in Capability Management Console (3×3 grid).

Square, brass label, mono metric, optional corner badge for RESTRICTED.

---

## 3. Global Layout Skeleton

```html
<body data-theme="retro">
  <header class="brass-scoreboard">…</header>
  <div class="gym-desk">
    <nav class="leather-rail">…</nav>
    <main class="board">
      <!-- tickets, lockers, etc. -->
    </main>
    <aside class="ledger-tape">…</aside>
  </div>
</body>
```

Mobile: leather-rail becomes bottom tab bar; ledger collapses under main or into a drawer.

---

## 4. Do / Don’t (enforced)

**Do**
- Hard shadows only.
- Stamps for every state change.
- High-contrast ink on paper.
- Square corners.
- Physical metaphors.

**Don’t**
- Soft shadows, gradients on cards, rounded modern cards.
- Light-gray text.
- Tiny icons as primary actions.
- Hamburger menus.
- Color-only status (always pair with stamp text).

---

## 5. Implementation Notes for Engineers

1. Existing tactical components stay under the default theme.
2. Add `data-theme="retro"` (or a feature flag) to enable this system.
3. Map current buttons → `.stamp` / `.brass-plate`.
4. Map current cards → `.paper-ticket`.
5. Map activity feeds → `.ledger-tape`.
6. All stamp clicks must write a ledger event (see `STAMP_AND_LEDGER_SCHEMA.md`).

---

**P0 complete when:** every core class above has a Storybook (or static HTML) example and the CSS variables are in the codebase.
