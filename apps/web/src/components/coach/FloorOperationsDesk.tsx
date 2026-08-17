'use client';

import { useState, type ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════════════════
   THE FLOOR OPERATIONS DESK — a room, one piece of furniture, and paper.

   ROOM (declared by the page, not here): `.room--floor`. Brick and mortar in
   offset courses under caged lamps.

   FURNITURE (declared here): one worn-leather desk bolted to the brick with
   four patina rivets, standing under a single caged fixture.
   `.mat-leather--worn` is the sheet's own nomination for "the kiosk shell,
   the coach desk, the console frame", and patina brass is its nomination for
   workaday hardware — Law 1 keeps polished `.mat-brass` for a crest.

   THE PANELS — the part worth arguing about.
   The one thing that has actually gone wrong on these consoles is CONTRAST,
   so material here follows legibility rather than mood, and it splits two
   ways:

     · The clearance panel (L12) carries a real participant safety state, and
       the Law 2 ladder was authored for the ink ground. `.badge--locked` on
       raised leather measures ~11:1; the same badge restated for a warm
       ground by `.on-canvas` measures ~4.3:1. So the panel that carries the
       ladder stands on the ground the ladder was tuned for. It is also the
       panel that should draw the eye first, and a dark instrument face
       between two cream sheets does exactly that.

     · The other two carry no safety state, only dense records — and dark ink
       on light stock is the most legible pair the system has. They are paper,
       in the stock the document would really be printed on: engineering graph
       for a counter, newsprint for a bill.

   Each paper panel also carries `.on-canvas`. A sheet of paper is a warm
   ground standing in a dark room, and every `.t-*` voice pins a LIGHT ink
   because it was authored for leather — `.t-data` in particular inherits
   `--bone-200`, two points off cream. `.on-canvas` is the sheet's own
   restatement of those voices for a warm ground ("wrap any of the affected
   components in .on-canvas … rather than re-deriving the palette per
   screen"). `.pap` is defined LATER in ppbf.css than `.on-canvas`, so at
   equal specificity the paper stock wins the background and `.on-canvas`
   contributes only the ink. That ordering was checked in the stylesheet, not
   assumed — assuming it is exactly how five pages once shipped bone on cream.

   LIGHT: the room declares `--sx: 0`, so every `.lift-*` here throws the same
   straight-down shadow without being told where the lamp is. One visible
   fixture, hung over bare brick above the desk and never over data — the
   sheet's own advice for dense working screens is that a glowing lamp in the
   corner is just one more thing competing with the figures.

   BUTTONS: there are none on this page, which makes it the cleanest test of
   the room treatment. The one control that exists — the rationale field — is
   marked inert in the same brass stamp family as "Planned — Not Yet
   Implemented"; see it below.
   ═══════════════════════════════════════════════════════════════════════════ */

type ClearanceItem = {
  id: string;
  athlete: string;
  checkpoint: string;
  status: 'pending' | 'ready';
};

type AttendanceRecord = {
  id: string;
  athlete: string;
  streakDays: number;
  absenceTag: 'excused' | 'unexcused';
  sessionsBooked: number;
  sessionCapacity: number;
};

type MatchupCard = {
  id: string;
  athleteA: string;
  athleteB: string;
  division: string;
  weighInChecklist: string[];
  opponentResearchWorkspace: string[];
};

/* ── THE DATA SEAM ──────────────────────────────────────────────────────────
   Everything below is fabricated, and the page says so in three places: the
   page-level SampleDataNotice, the brass stamp in the masthead, and the
   sentence under it. It is deliberately kept in ROW SHAPES a real feed can
   fill — swap these three consts for fetched rows of the same types and not
   one line of markup below has to change. Nothing here reads or writes a
   record, and every one of those three declarations stays until that stops
   being true. */

const clearanceChecklist: ClearanceItem[] = [
  {
    id: 'clr-001',
    athlete: 'Mila Ortega',
    checkpoint: 'Concussion protocol sign-off',
    status: 'pending',
  },
  {
    id: 'clr-002',
    athlete: 'Andre Porter',
    checkpoint: 'Mobility and pain-free movement',
    status: 'ready',
  },
  {
    id: 'clr-003',
    athlete: 'Lena Cho',
    checkpoint: 'Cardio tolerance re-evaluation',
    status: 'pending',
  },
];

const attendanceMonitor: AttendanceRecord[] = [
  {
    id: 'att-001',
    athlete: 'Mila Ortega',
    streakDays: 9,
    absenceTag: 'excused',
    sessionsBooked: 4,
    sessionCapacity: 6,
  },
  {
    id: 'att-002',
    athlete: 'Andre Porter',
    streakDays: 14,
    absenceTag: 'unexcused',
    sessionsBooked: 6,
    sessionCapacity: 6,
  },
  {
    id: 'att-003',
    athlete: 'Lena Cho',
    streakDays: 5,
    absenceTag: 'excused',
    sessionsBooked: 3,
    sessionCapacity: 6,
  },
];

const matchmakerBoard: MatchupCard[] = [
  {
    id: 'mm-001',
    athleteA: 'Andre Porter',
    athleteB: 'Jonah Ruiz',
    division: 'Youth Welterweight',
    weighInChecklist: [
      'Photo ID verified',
      'Hydration check complete',
      'Official scale signed',
    ],
    opponentResearchWorkspace: [
      'Counter right-hand tendency mapped',
      'Front-foot pressure entry noted',
      'Defensive shell drop in rounds 2-3',
    ],
  },
  {
    id: 'mm-002',
    athleteA: 'Mila Ortega',
    athleteB: 'Rina Alvarez',
    division: 'Youth Flyweight',
    weighInChecklist: [
      'Guardian consent reconfirmed',
      'Weight class confirmed',
      'Medical notes attached',
    ],
    opponentResearchWorkspace: [
      'Lead hook exit lane identified',
      'Clinching frequency high near ropes',
      'Late-round cardio decline trend',
    ],
  },
];

const IMMUTABLE_GATE = 'Pending Coach Verification Flag {"verified_by_jason": false}';

/* ── REFERENCE MARKS ────────────────────────────────────────────────────────
   L12 / L27 / L29 and [V-COACH] are reference marks, not content: they name
   the capability layer a panel implements and the audience it is visible to.
   They are set in brass, in the record voice at 11px — the same recessive
   family as the brass "Planned — Not Yet Implemented" stamp. Brass is chassis
   (Law 1), which is exactly why a reference mark may wear it and a status
   never may.

   They are in their INACTIVE state, and that is the only state this component
   builds. A mark becomes active when its layer's README condition is met;
   that condition does not exist yet, so there is nothing to read it from and
   nothing to compute.

   THE SEAM is `data-ref-state` below. When the condition ships: compute it,
   pass "active" in place of the hardcoded "inactive", and add the active rule
   to ppbf.css keyed off that attribute — no markup here moves. Deliberately
   NOT a feature flag and NOT a role check: a mark that lights up for some
   readers and not others has become a status, and Law 2 says status is not
   what brass is for. */
function RefMark({ children }: { readonly children: ReactNode }) {
  return (
    <span
      className="t-eyebrow"
      data-ref-state="inactive"
      title="Reference mark — inactive until this layer's condition is met"
    >
      {children}
    </span>
  );
}

/* The masthead every panel wears, so the three panels agree about their type
   ladder no matter what they are made of: reference marks, then the panel's
   name in the display voice at --t-lg, then one line of plain prose saying
   what it is. `surface` is the material the panel is made of and the only
   thing that varies. */
function DeskPanel({
  surface,
  rule,
  refs,
  name,
  blurb,
  children,
}: {
  readonly surface: string;
  readonly rule: string;
  readonly refs: readonly string[];
  readonly name: string;
  readonly blurb: string;
  readonly children: ReactNode;
}) {
  return (
    <article className={`${surface} p-[var(--s5)]`}>
      <header className={`border-b pb-[var(--s3)] ${rule}`}>
        <p className="flex flex-wrap items-center gap-[var(--s4)]">
          {refs.map((ref) => (
            <RefMark key={ref}>{ref}</RefMark>
          ))}
        </p>
        <h2 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-lg)' }}>
          {name}
        </h2>
        <p className="t-muted mt-[var(--s2)]">{blurb}</p>
      </header>
      {children}
    </article>
  );
}

/* One record on a panel. The athlete's name is the display voice at --t-md —
   the kiosk minimum (Law 5). This is a desk rather than a kiosk and desks may
   go smaller, but the desk is standing on the gym floor, and a row header a
   coach has to find at arm's length in bad light is worth the rung. The facts
   under it drop to the record voice, which is where Law 4 puts anything
   auditable. */
function RecordRow({
  athlete,
  rule,
  children,
}: {
  readonly athlete: string;
  readonly rule: string;
  readonly children: ReactNode;
}) {
  return (
    <li className={`border-t pt-[var(--s4)] first:border-t-0 first:pt-0 ${rule}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
        <p className="t-command" style={{ fontSize: 'var(--t-md)' }}>
          {athlete}
        </p>
        <RefMark>[V-COACH]</RefMark>
      </div>
      {children}
    </li>
  );
}

/* A labelled fact, in the record voice. Two columns so the values line up down
   the panel — which is the whole reason mono exists in Law 4. */
function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="t-label">{term}</dt>
      <dd className="t-data m-0">{children}</dd>
    </>
  );
}

/* Materials, named once so the three panels read as a set rather than as three
   strings of utilities. */
const INSTRUMENT_FACE = 'mat-leather--raised mat-stitch rounded-[var(--r-md)]';
const INSTRUMENT_RULE = 'border-[color:var(--brass-800)]';
/* Square corners on the paper, twice over: a sheet of paper has square
   corners, and `.age-1`'s multiply overlay is an un-rounded rectangle that
   would show its own corners outside a rounded edge. */
const TALLY_SHEET = 'on-canvas pap pap--graph age-1 lift-2';
const BILL_SHEET = 'on-canvas pap pap--news age-1 lift-2';
const PAPER_RULE = 'border-[color:var(--card-ink-muted)]';

export default function FloorOperationsDesk() {
  const [downgradeRationale, setDowngradeRationale] = useState('');

  return (
    <section className="mx-auto w-full max-w-7xl">
      {/* The fixture. One caged lamp, hung on bare brick above the desk so its
          pool falls on wall rather than on figures. `.lamp` hangs from the top
          edge of a positioned parent, so the strip is what gives it something
          to hang from; the desk below paints over the tail of the pool, which
          is what a desk standing in front of a wall lamp actually does. */}
      <div className="relative h-[var(--s7)]" aria-hidden="true">
        <span className="lamp lamp--caged left-1/2 -translate-x-1/2" />
      </div>

      {/* The desk: worn hide, bolted to the brick at four corners. */}
      <div className="mat-leather--worn relative rounded-[var(--r-lg)] p-[var(--s5)] md:p-[var(--s6)]">
        <span className="rivet rivet--patina rivet--tl" aria-hidden="true" />
        <span className="rivet rivet--patina rivet--tr" aria-hidden="true" />
        <span className="rivet rivet--patina rivet--bl" aria-hidden="true" />
        <span className="rivet rivet--patina rivet--br" aria-hidden="true" />

        <header className="border-b border-[color:var(--brass-800)] pb-[var(--s4)]">
          <p className="t-eyebrow">Bundle 2: Layers 12, 27, 29</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Coach Floor Operations Desk
          </h1>
          {/* Pinned by floorOperationsDeskHonesty.test.tsx, and rightly: a
              fabricated return-to-play clearance must never read as a real
              one. The stamp and the sentence below it are the page admitting
              what it is, in the voice Law 7 reserves for governance. Restyle
              around them; do not reword them. */}
          <p className="mt-[var(--s4)]">
            <span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span>
          </p>
          {/* No `text-[color:…]` here on purpose. Tailwind's utilities live in
              `@layer utilities` and ppbf.css is unlayered, so `.t-body`'s own
              `color` beats any utility regardless of specificity — a colour
              utility on a voice class is dead code that reads like a decision.
              Restate a voice through the ground (.on-canvas below), never by
              piling a utility on top of it. */}
          <p className="t-body mt-[var(--s4)] max-w-[70ch]">
            Every athlete, clearance, attendance figure, and matchup below is fabricated sample data.
            Nothing on this desk reads or writes real records — do not act on anything it shows.
          </p>
        </header>

        <div className="mt-[var(--s5)] grid items-start gap-[var(--s5)] lg:grid-cols-3">
          {/* ── L12 · the gate ───────────────────────────────────────────────
              The only panel on the desk carrying a participant safety state,
              and therefore the only one on the ink ground: the Law 2 ladder
              reads at ~11:1 on raised leather against ~4.3:1 restated for a
              warm ground. */}
          <DeskPanel
            surface={INSTRUMENT_FACE}
            rule={INSTRUMENT_RULE}
            refs={['L12', '[V-COACH]']}
            name="Medical & Recovery"
            blurb="Return-to-Play Clearance Checklist"
          >
            {/* Law 7: the gate refuses, and a refusal is a stamp. It is
                stated ONCE for the panel rather than repeated under every
                row — it is one flag standing over all of them, and three
                copies of the same red mark spends the ladder on emphasis,
                which is precisely what Law 2 forbids. */}
            <div className="mt-[var(--s4)]">
              <p className="flex flex-wrap items-center gap-[var(--s3)]">
                <span className="stamp stamp--sm stamp--flat">Not Verified</span>
                <span className="t-data break-all">{IMMUTABLE_GATE}</span>
              </p>
              <p className="t-muted mt-[var(--s3)]">
                One coach-verification flag stands over every checkpoint below. Nothing on this
                panel clears an athlete for contact.
              </p>
            </div>

            {/* The desk's only control. It holds local state and persists
                nothing, so it says so in the brass stamp family rather than
                pretending to be operative — and it stays reachable and
                typable rather than being disabled, because a dead-looking
                control teaches a coach the surface is broken instead of
                unbuilt. THE SEAM: when the rationale is actually recorded,
                drop the stamp and the note, and wire onChange to the writer;
                nothing else in this block changes. */}
            <div className="field mt-[var(--s5)]">
              <label className="t-label" htmlFor="downgrade-rationale">
                Mandatory Downgrade / Modification Rationale
              </label>
              <input
                id="downgrade-rationale"
                type="text"
                value={downgradeRationale}
                onChange={(event) => setDowngradeRationale(event.target.value)}
                data-testid="drpe-lockout-input"
                aria-describedby="downgrade-rationale-note"
                className="input mt-[var(--s2)]"
              />
              <p id="downgrade-rationale-note" className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
                <span className="stamp stamp--sm stamp--brass stamp--flat">Not Wired</span>
                <span className="t-muted">Typing here changes nothing and is saved nowhere.</span>
              </p>
            </div>

            <ul className="mt-[var(--s5)] space-y-[var(--s4)]">
              {clearanceChecklist.map((item) => (
                <RecordRow key={item.id} athlete={item.athlete} rule={INSTRUMENT_RULE}>
                  {/* Law 3: never colour alone. Every rung carries its glyph
                      and its uppercase word, so the row survives greyscale
                      print and every form of colour blindness.

                      'ready' is deliberately --monitor and not --cleared. The
                      checkpoint is ready for sign-off; the athlete is not
                      cleared, and the gate above says so. Spending the green
                      rung here would be the ladder lying. */}
                  <p className="mt-[var(--s3)]">
                    {item.status === 'pending' ? (
                      <span className="badge badge--locked">
                        <i aria-hidden="true">✕</i>Pending
                      </span>
                    ) : (
                      <span className="badge badge--monitor">
                        <i aria-hidden="true">◉</i>Ready for sign-off
                      </span>
                    )}
                  </p>
                  <dl className="mt-[var(--s3)] grid grid-cols-[auto_1fr] gap-x-[var(--s4)] gap-y-[var(--s2)]">
                    <Fact term="Checkpoint">{item.checkpoint}</Fact>
                    <Fact term="Record">{item.id}</Fact>
                  </dl>
                </RecordRow>
              ))}
            </ul>
          </DeskPanel>

          {/* ── L27 · the tally sheet ────────────────────────────────────────
              Counters and streaks, so it is engineering graph paper — the
              stock the sheet's own paper system nominates for figures. */}
          <DeskPanel
            surface={TALLY_SHEET}
            rule={PAPER_RULE}
            refs={['L27', '[V-COACH]']}
            name="Attendance Control"
            blurb="Consecutive Streak Monitor · Excused / Unexcused Absence Tags · Session Capacity Counter"
          >
            <ul className="mt-[var(--s4)] space-y-[var(--s4)]">
              {attendanceMonitor.map((record) => (
                <RecordRow key={record.id} athlete={record.athlete} rule={PAPER_RULE}>
                  {/* Law 2, held: an absence tag is an administrative state,
                      not a participant's safety state, so it does NOT get the
                      red rung — `--filed` is the sheet's own administrative
                      grey, explicitly "never for anything Layer 11 or a queue
                      outcome actually gates on." Excused and unexcused are
                      told apart by glyph and word rather than by hue, which
                      is what Law 3 asks for anyway. */}
                  <p className="mt-[var(--s3)]">
                    {record.absenceTag === 'unexcused' ? (
                      <span className="badge badge--filed">
                        <i aria-hidden="true">▢</i>Unexcused absence tag
                      </span>
                    ) : (
                      <span className="badge badge--filed">
                        <i aria-hidden="true">▣</i>Excused absence tag
                      </span>
                    )}
                  </p>
                  <dl className="mt-[var(--s3)] grid grid-cols-[auto_1fr] gap-x-[var(--s4)] gap-y-[var(--s2)]">
                    <Fact term="Streak">{record.streakDays} consecutive days</Fact>
                    <Fact term="Capacity">
                      {record.sessionsBooked} / {record.sessionCapacity}
                      {record.sessionsBooked >= record.sessionCapacity ? ' — full' : ''}
                    </Fact>
                    <Fact term="Record">{record.id}</Fact>
                  </dl>
                </RecordRow>
              ))}
            </ul>
          </DeskPanel>

          {/* ── L29 · the bill ───────────────────────────────────────────────
              A matchmaker board is a fight bill, so it is printed on
              newsprint. The weigh-in steps are procedure and stay in the
              record voice with an unticked box, which is the honest state of
              a checklist on a surface that cannot tick anything. The opponent
              notes are the coach's own annotation, which is the one job Law 4
              gives the hand voice. */}
          <DeskPanel
            surface={BILL_SHEET}
            rule={PAPER_RULE}
            refs={['L29', '[V-COACH]']}
            name="Competition Management"
            blurb="Matchmaker Board"
          >
            <ul className="mt-[var(--s4)] space-y-[var(--s4)]">
              {matchmakerBoard.map((card) => (
                <RecordRow
                  key={card.id}
                  athlete={`${card.athleteA} vs ${card.athleteB}`}
                  rule={PAPER_RULE}
                >
                  <dl className="mt-[var(--s3)] grid grid-cols-[auto_1fr] gap-x-[var(--s4)] gap-y-[var(--s2)]">
                    <Fact term="Division">{card.division}</Fact>
                    <Fact term="Record">{card.id}</Fact>
                  </dl>

                  <p className="t-label mt-[var(--s4)]">Weigh-In Checklist</p>
                  <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                    {card.weighInChecklist.map((item) => (
                      <li key={item} className="t-data flex gap-[var(--s3)]">
                        <span aria-hidden="true">▢</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>

                  <p className="t-label mt-[var(--s4)]">Opponent Research Workspace</p>
                  <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                    {card.opponentResearchWorkspace.map((item) => (
                      // The hand voice at --t-md: a script face reads smaller
                      // than its nominal size, and .t-hand pins 14px in a
                      // longhand a layered utility cannot beat, so the rung is
                      // set inline the way ppbf.css's own note prescribes.
                      <li key={item} className="t-hand" style={{ fontSize: 'var(--t-md)' }}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </RecordRow>
              ))}
            </ul>
          </DeskPanel>
        </div>
      </div>
    </section>
  );
}
