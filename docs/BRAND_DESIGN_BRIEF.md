# PPBF Brand & Visual Design Brief

A copy-paste-ready reference for generating **on-brand external visuals** — posters,
social cards, flyers, grant-packet covers — in Canva or any design/image tool that
cannot read the app's CSS.

> **Source of truth = [design-system/ppbf.css](../design-system/ppbf.css).** The
> values below are transcribed from it. When anything conflicts, the stylesheet
> wins. This is the **only** document allowed to restate hex values, and only
> because external tools can't read a token — inside the app, always use the
> tokens. See [FRONTEND_STYLE_CONTRACT.md](FRONTEND_STYLE_CONTRACT.md).
>
> Read [design-system/README.md](../design-system/README.md) first. The Eight Laws
> apply to a poster exactly as they apply to a screen.

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

**"Leather & Brass"** — the back office of a boxing gym that has been run properly
for forty years. Oiled leather, cast brass, a slate board with today's sessions on
it, a cork wall of pinned notes, and a stamp pad for anything official.

Not a flat "tactical" look and not glossy skeuomorphism: **every surface is one of
five real materials** — leather, brass, slate, cork, paper (Law 6). Most hardware in
a gym run forty years on donations is *oxidized, not polished* — so patina is
load-bearing and polished brass is reserved for the few things that would actually
see a polishing rag.

Avoid: glossy gradients, soft blurred shadows, rounded "friendly SaaS" cards,
slate/emerald/cyan theme fragments, and any saturated colour that isn't reporting
a safety state.

## 3. Two grounds — pick one before anything else

| Ground | Hex | Use for |
|---|---|---|
| **Ink** | `#14100D` | Staff and tactical pieces — coach material, board packets, internal |
| **Warm canvas** | `#EFE4C8` | Family and public pieces — enrollment, guardian, community, recruiting |

This is a real decision, not a style preference (Law 6). A recruiting flyer for
families is canvas; a coaching load profile is ink. Getting it wrong is the most
visible possible error.

## 4. Colour palette (exact)

**Leather — the ground**
| Token | Hex | |
|---|---|---|
| `--hide-950` | `#14100D` | deepest shadow, ink ground |
| `--hide-900` | `#1E1712` | panel interior |
| `--hide-800` | `#2A1F18` | standard leather face |
| `--hide-700` | `#3B2C21` | raised leather, tiles |
| `--hide-600` | `#4A3728` | tag face, hover |
| `--hide-500` | `#5C4632` | stitched edge highlight |

**Brass — the chassis (never the message, Law 1)**
| Token | Hex | |
|---|---|---|
| `--brass-800` | `#6B4E12` | shadow side |
| `--brass-500` | `#B8912F` | nominal brass |
| `--brass-300` | `#E8CE7A` | specular highlight |
| `--brass-200` | `#F2E2A8` | hottest highlight |

**Patina — oxidized hardware, the load-bearing metal**
`--patina-900` `#262418` · `--patina-700` `#46421F` · `--patina-500` `#6B6430` ·
`--patina-300` `#8E8548` · `--patina-100` `#B5AA6E`

**Rust — atmosphere only, never status**
`--rust-900` `#241009` · `--rust-700` `#3E1B12` · `--rust-500` `#5C2A1C` ·
`--rust-300` `#7A4130`

Deliberately far from `--locked` in hue and saturation so old blood on a wall can
never be mistaken for a safety state.

**Bone & paper — type and printed surfaces**
| Token | Hex | |
|---|---|---|
| `--bone-100` | `#F7F1E1` | stencil display type |
| `--bone-200` | `#EFE6D0` | body copy on leather |
| `--bone-300` | `#DCCFB2` | secondary on leather |
| `--bone-400` | `#B5A688` | tertiary, captions |
| `--paper` | `#F4EBD4` | torn notes, board packets |
| `--canvas-warm` | `#EFE4C8` | the warm ground |

**Chalk, slate & cork**
`--slate-board` `#1C2420` · `--chalk` `#E6E3D6` · `--chalk-dim` `#9FA79C` ·
`--cork` `#C08E4E` · `--cork-dark` `#96682F`

**Status ladder — the entire saturated-colour budget (Law 2)**
| State | Token | Hex | Glyph |
|---|---|---|---|
| Cleared | `--cleared` | `#3F7D4E` | `✓` |
| Monitor | `--monitor` | `#2E6E96` | `◉` |
| Restricted | `--restricted` | `#C05A1E` | `▲` |
| Locked | `--locked` | `#A81E22` | `✕` |

Stamps: `--stamp-red` `#A81E22` (refusal, redaction, destructive) ·
`--stamp-green` `#2F7A3E` (approved, compliant).

These four are chosen to sit correctly on leather while staying clearly separate
from a gold bezel. **A saturated pixel anywhere else is a bug** — against leather
and brass it is unmissable, and the whole budget is spent on safety state.

**Law 3 — colour is never the only channel.** Every state carries its glyph and an
uppercase label, so the ladder survives greyscale printing for board packets and
every form of colour blindness. A poster that distinguishes states by colour alone
is off-brand even if the hexes are right.

## 5. Typography

| Use | Ships as | Design-system intent | Notes |
|---|---|---|---|
| Headings, buttons, mottos ("stencil") | **Oswald** (400/500/700) | Big Shoulders Stencil / Stardos Stencil | condensed poster face; tracking 1–2px; leading 1.2 |
| Body | **Roboto Condensed** (400/700) | Inter | leading 1.5 |
| Chalk / schedules | — | Segoe Print, Bradley Hand, Chalkboard SE | handwriting; erasable by definition |
| Mono — IDs, timestamps, RPE, hashes | **Geist Mono** | ui-monospace | UPPERCASE, letter-spacing to 0.35em |

The app ships Oswald because it is a really loaded face where the stencil fallback
chain is not; swapping to a licensed stencil is one token in `ppbf.css`. For
external visuals, **a true condensed stencil is preferred** — that is the intended
voice.

**Four voices, each with a job (Law 4):** stencil *commands*, bone sans *informs*,
chalk *schedules*, mono *records* anything auditable. Don't mix their jobs.

**Type scale — √φ (1.272) steps from a 15px base (Law 8):**
11.8 · 15 · 19.1 · 24.3 · 30.9 · 39.3 · 50 · 63.6

## 6. Proportion — φ is load-bearing (Law 8)

| Axis | Rule | Values |
|---|---|---|
| Type | climbs by √φ from 15px | see above |
| Space | Fibonacci | 3 · 5 · 8 · 13 · 21 · 34 · 55 · 89 |
| Radius | Fibonacci | 5 · 8 · 13 · 21 |
| Layout | the golden section | 38.2% / 61.8% |
| Gauges | 144 × 89 — a true golden rectangle | |

Lay a poster out on the 38.2 / 61.8 split and size its margins off the Fibonacci
scale. Nothing is sized by eye.

## 7. Signature treatments

- **Generated grain, no external assets:** fractal-noise SVG overlay
  (`feTurbulence`), the texture on every surface. Ink ground carries it heavier
  than canvas.
- **Materials, not fills:** leather is a layered gradient with a warm top-left
  bloom and a dark bottom-right falloff; brass is a multi-stop diagonal with a
  specular band; both read as objects lit from one direction.
- **Saddle stitching:** a 1.5px dashed bone rule inset ~6px from a leather edge.
- **Rivets:** small brass (or patina) domes at panel corners — chassis, never status.
- **Corners:** square by default; radius only where a real object would have one.
- **Offset shadows, no blur** — the hard gym-desk shadow:
  `2px 2px 0` / `4px 4px 0` / `6px 6px 0` in black at 30–50% opacity.
- **Stamps are permanent ink** (Law 7): refusals and redactions are stamped on the
  page — `RESEARCH NEEDED`, `REDACTED` — not floated as a dismissible notice.
- **Touch targets:** 55px minimum with 19.1px type on anything used on the gym
  floor (Law 5) — sweaty hands, bad light, a queue behind them.

## 8. Ready-made prompt for Canva / image tools

> Create a [poster / social card / flyer] for **Punxsy Prominence Boxing & Fitness**,
> a nonprofit youth boxing program serving rural Pennsylvania at no cost to families.
> Aesthetic: **the back office of a boxing gym run properly for forty years** —
> oiled leather, oxidized brass, slate, cork, stamped paper. Every surface must read
> as one of those real materials, lit from one direction, with a faint film-grain
> texture over everything.
>
> Ground: **[warm aged canvas `#EFE4C8` for family/public | deep ink-brown `#14100D`
> for staff/board]**. Leather panels in `#2A1F18` with a dashed bone saddle-stitch
> rule inset from the edge. Hardware — frames, rivets, bezels — in **oxidized
> patina** `#6B6430`/`#46421F`, with polished brass `#B8912F` (highlight `#E8CE7A`)
> reserved for one ceremonial element only. Type in warm bone `#EFE6D0`.
>
> Headlines in a **condensed stencil** face, uppercase, wide letter-spacing; body in
> a condensed sans; tiny uppercase mono labels for any ID, date, or number.
> **Hard blur-free offset drop shadows** (`4px 4px 0` black) on square panels — no
> soft shadows, no glossy gradients, no rounded SaaS cards, no blue or cyan.
>
> **Use saturated colour for one thing only:** a safety or status mark — olive-green
> `#3F7D4E` cleared, orange `#C05A1E` restricted, crimson `#A81E22` locked — and
> always pair it with a glyph (`✓ ▲ ✕`) and an uppercase word, never colour alone.
> Everything else stays leather, patina, and bone.
>
> Lay it out on a golden-section split (38.2% / 61.8%) with margins from the
> Fibonacci scale (13/21/34/55px). Disciplined and safety-forward, not hype.

## 9. Known gaps / to supply

- **No logo asset in the repo** — `public/` contains only default Next.js SVGs.
  Provide a wordmark/mark, or have a design tool propose one in the stencil style.
- **The stencil face is unlicensed.** Big Shoulders Stencil / Stardos Stencil should
  be self-hosted (the floor kiosk renders offline, and Law 6 makes type part of the
  chassis, not a progressive enhancement). Until then the app ships Oswald.

## References

- `design-system/ppbf.css` — the source of truth for every value above
- `design-system/README.md` — the direction and the Eight Laws
- `design-system/index.html` — browsable foundation, component, and screen previews
- `apps/web/app/globals.css` — the app's import + legacy alias layer
- `apps/web/app/layout.tsx` — font wiring (Oswald / Roboto Condensed / Geist Mono)
