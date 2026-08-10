# Golden Era Phase 2 — Engagement, Authenticity & Belonging Roadmap

*Working document — add to this as new ideas come up. Nothing here is locked until we move it into execution phases.*

---

## Flow & Polish

- [ ] Tab active state gets a clear visual indicator (admin console)
- [ ] Panel/detail expansion gets a smooth transition instead of popping open instantly
- [ ] Form submissions show real feedback (disabled state, spinner, success confirmation that feels earned)
- [ ] Breadcrumbs added so people always know where they are across all 68 pages
- [ ] Button hierarchy established (primary/secondary/danger consistent everywhere)
- [ ] Empty states explain themselves instead of showing a blank table

## Voice & Authenticity

- [ ] Rewrite athlete-facing system messages (e.g. "Session check-in persisted to pilot backend") into real gym language
- [ ] Rewrite public page copy end-to-end — replace corporate phrasing ("program lane," "development visibility") with language a nervous parent or new member actually trusts
- [ ] Remove leftover internal/dev labels from live admin screens
- [ ] Fix cramped scroll boxes in the coach workspace (rosters/tasks no longer squeezed into tiny windows)

## The Bell (Sound + Ceremony)

- [ ] Wire up the existing-but-unused sound system — check-ins, milestones
- [ ] Milestone ceremony — real moment (visual seal press, sound, maybe a shared marquee) when someone crosses a Fibonacci milestone

## Efficiency for Power Users

- [ ] Batch select / bulk actions in admin
- [ ] Extend the ⌘K command palette from navigation into actual actions

## First Impression (Public Page)

- [ ] Sequence the page to lead with feel and character before asking for forms
- [ ] Add texture and small sound/motion touches for physical-feeling interactions
- [ ] Make the confirmation moment feel like being let in, not a database write succeeding
- [ ] Extra care on load speed — this is where people decide in seconds

## Real Photography

- [ ] Gym space photos on the public page (ring, bags, entrance, texture)
- [ ] Real people/session photos
- [ ] Rotating "gym wall" photo module on dashboards
- [ ] Staff/coach bios with real photos and short stories

## Personalization & Belonging (All Users)

- [ ] Profile photo + nickname for everyone
- [ ] Customizable dashboard elements per user
- [ ] Role-specific personal spaces (athlete's "corner," coach's roster with real faces)
- [ ] Corner color choice (red corner / blue corner) as a personal accent
- [ ] "Fight card" style bio format

## Achievements, Broadened Beyond Fighting

- [ ] Personal record wall expanded to include self-defined goals, not just fight stats
- [ ] Character and values recognition — coaches "catching" good behavior, not just performance
- [ ] Non-fight milestones — conditioning, consistency, life skills
- [ ] Mentorship visibility — who's mentoring whom
- [ ] Alumni / "where are they now" stories
- [ ] Public page reflects full range of programs — youth mentorship, fitness-only members, adult recreational boxing, and other offerings
- [ ] Family-facing achievement framing (what a parent cares about, not just technical stats)

## Media & Recognition (via Existing Shadow Upload Capability)

- [ ] Extend Shadow's file upload to handle photos (and possibly short video/voice notes)
- [ ] Coach shoutouts sent to athletes
- [ ] Voice notes from coach to athlete
- [ ] Video clips for technique review

## Community Touches

- [ ] Shared gym wall of real photos
- [ ] Team/stable roster with real faces
- [ ] Chalk-board style shared announcements

## Physical/Spatial Feel

- [ ] Lean harder into the existing "room" model so different areas genuinely feel like different rooms in the gym

## Easter Eggs

- [ ] Hidden way to manually ring the Bell
- [ ] Boxing-significant numbers (12, 3) get special milestone treatment
- [ ] Quiet time-of-day and anniversary recognitions
- [ ] Small nod for power users who discover ⌘K

## Motivational Banners

- [ ] Real sayings from actual coaches (need these — collect when available)
- [ ] "Words on the wall" module styled like real gym signage
- [ ] Shown contextually (after a hard session or milestone), not as a constant banner

---

## Open Questions / Needs From You

- Real gym photos (space, people, entrance) — some may already be available, more to be taken at the gym
- Real coach sayings/quotes for the motivational banners
- Confirmation on which programs to reflect on the public page (youth mentorship, fitness-only, adult recreational boxing, others)

---

## Additions

*(New ideas get added here as they come up, before being sorted into the sections above.)*

### Take It Over The Top

Effort notes reflect whether something is a **new page reading existing data** (additive, low risk)
or a **change to existing behavior** (higher risk, later phase).

**The Wall Display — gym TV** — ADDITIVE, ~1 day
A new route the gym TV points a browser at. Today's sessions, who's checked in, and a name
that goes up on the marquee when someone crosses a milestone. Reads existing backend data.
Touches none of the 68 existing pages. `.marquee` already exists in the design system with
zero consumers — it was anticipated and never built.
*Confirmed: gym has a TV available.*
- [ ] Bare-bones version first — sessions, check-ins, milestone names
- [ ] Layer the Bell sound + seal animation on after seeing it live

**Printed artifacts** — ADDITIVE, ~half day
Fight-card-style record, milestone certificate, year-end card. The design system is already
stamp/seal-based, which is print vocabulary. Template + print stylesheet.
- [ ] Decide: real printer at the gym, or PDF people print at home?

**Wall of names (permanent)** — ADDITIVE, small
Everyone who's come through, still visible after they've gone. Gives the alumni idea
somewhere to live. New page querying existing athlete records.

**Voice notes for coaches** — MEDIUM
Coaches have taped hands and 40 seconds between rounds; typing is hostile. Hold-to-talk,
note lands on the athlete's record, optionally reaches them as the coach's actual voice.
Upload path exists via Shadow; browsers record audio natively. New work is the athlete-side
player and a retention policy.

**Parent digest — the blind spot** — MEDIUM (in-app) / LARGER (email)
The person paying almost never sees the room. What their kid worked on, a photo from a
session, what their coach said. Strongest retention mechanic available.
- [ ] In-app version is much cheaper — email needs a sending pipeline that doesn't exist yet

**Before and after** — FRAME NOW, FILLS IN OVER TIME
First-session clip/photo held next to a current one, surfaced at a milestone or anniversary.
Can't land until there's history to draw on. Build the frame; it populates itself.

**The gym's own voice — chalkboard** — ADDITIVE, small
Staff-posted, shows up everywhere. Not notifications, not announcements — the thing that
would be written on a board by the door. Written by a person, in their words.

**At-the-gym vs at-home modes** — HOLD FOR LATER
Floor kiosk = loud, big, one-thumb, sweaty hands. Home = quiet, reflective, review and plan.
The room model already anticipates this but currently only changes wallpaper, not behavior.
This one *changes existing pages* rather than adding new ones — higher risk, later phase.
Cheap partial version exists: athlete routes are already on ink/floor-kiosk via PAGE_MAP.

---

### Answers Received

- **TV for wall display:** yes, available at the gym
- **Consent for photos/video of minors:** yes, covered
- **Upload infrastructure:** exists, tied to Shadow — extendable to photos/video/voice
- **Backend:** real, safe to extend with photo/profile fields
- **Personalization scope:** all users, self-serve

### Still Open

- Printer at the gym, or PDF-at-home for printed artifacts?
- Real coach sayings for the banners
- Which programs to feature on the public page
