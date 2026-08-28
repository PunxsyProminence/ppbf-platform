"use client";

import { useEffect, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatMeasuredAt, type BoardCountMetric } from '../BoardSummaryPanel';

// Three finished board routes had no reader anywhere in the app: a board seat
// could only reach volunteer, external-competition and wrestling-league
// aggregates by curling the API. Each one is the board's ONLY window onto its
// subject -- the roster, competition and league APIs themselves 403 a board
// session (COMPETITION_READ_ROLES and LEAGUE_READ_ROLES in
// src/server/pilot/*.ts, held by boardRoleBoundaries.test.ts) -- so an
// unrendered aggregate is not a missing convenience, it is the refusal
// standing with nothing behind it.
//
// The contracts are mirrored here rather than imported: the server modules
// pull ./db and its Postgres driver, which must not cross the client
// boundary. BoardSummaryPanel.tsx mirrors the hub's contract for the same
// reason and is the source for BoardCountMetric.

interface VolunteerSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  volunteersByStatus: {
    active: BoardCountMetric;
    pending: BoardCountMetric;
    inactive: BoardCountMetric;
  };
  newVolunteers30Days: BoardCountMetric;
}

interface ExternalCompetitionSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  // Raw integers, not metrics. A competition is an organizational scheduling
  // fact tied to no athlete, so it passes through no k-anonymity gate on the
  // server and cannot arrive withheld.
  competitionsByStatus: {
    planned: number;
    completed: number;
    cancelled: number;
  };
  entriesByResult: {
    won: BoardCountMetric;
    lost: BoardCountMetric;
    draw: BoardCountMetric;
    no_contest: BoardCountMetric;
  };
}

interface WrestlingLeagueSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  seasonsByStatus: {
    planned: number;
    active: number;
    completed: number;
  };
  rosteredAthletes: BoardCountMetric;
}

const VOLUNTEER_ENDPOINT = '/api/pilot/board/volunteer-summary';
const COMPETITION_ENDPOINT = '/api/pilot/board/external-competition-summary';
const LEAGUE_ENDPOINT = '/api/pilot/board/wrestling-league-summary';

// BOARD_MINIMUM_COHORT_SIZE in src/server/pilot/boardSummary.ts, restated
// because that module reaches the database. Only used to word the withholding
// sentence before a response arrives; every rendered figure uses the floor the
// response itself reports, so a server-side change to the floor cannot be
// contradicted by a stale number on screen.
const FALLBACK_MINIMUM_COHORT_SIZE = 5;

interface AggregateRead<T> {
  summary: T | null;
  isLoading: boolean;
  errorMessage: string;
}

/**
 * One reader for all three routes, because all three answer the same envelope
 * -- and that envelope is the trap on this surface. GET
 * /api/pilot/board/summary answers `success: true`, which is what
 * BoardSummaryPanel checks; these three answer `ok: true` (see each route.ts,
 * and board/escalation-summary and board/compliance-summary alongside them).
 * A reader that copied the hub's check would reject every good response, for
 * good, without an error anybody could see -- the board would simply be told
 * the figures were unavailable forever.
 *
 * Each section keeps its own read state. One route failing must not blank the
 * two that answered: an empty section and a section that could not be read are
 * different facts, and this page exists to keep exactly that kind of pair
 * apart.
 */
function useBoardAggregate<T>(endpoint: string, readFailureMessage: string): AggregateRead<T> {
  const [summary, setSummary] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}${endpoint}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(readFailureMessage);
        }
        const payload = (await response.json()) as { ok?: boolean; summary?: T };
        if (payload.ok !== true || !payload.summary) {
          throw new Error(readFailureMessage);
        }
        setSummary(payload.summary);
        setErrorMessage('');
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setSummary(null);
        setErrorMessage(error instanceof Error ? error.message : readFailureMessage);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [endpoint, readFailureMessage]);

  return { summary, isLoading, errorMessage };
}

interface TileDisplay {
  value: string;
  note: string;
  /** Drawn as a stamp rather than a figure -- see AggregateTile. */
  withheld: boolean;
}

/**
 * A k-anonymity-gated figure has three outcomes and they are three different
 * facts. boardSummary.ts keeps them apart all the way from the query
 * (`boardAggregateStatus`); this is the last place they could still collapse,
 * and a collapse here is the one that reaches a fiduciary.
 */
function gatedDisplay(
  metric: BoardCountMetric | undefined,
  minimumCohortSize: number,
  isLoading: boolean,
  unitLabel: string,
  cohortNoun: string,
): TileDisplay {
  if (isLoading) {
    return { value: '...', note: 'Loading.', withheld: false };
  }

  if (!metric) {
    return { value: 'Not read', note: 'This figure did not arrive.', withheld: false };
  }

  if (metric.status === 'insufficient_data') {
    return {
      value: 'Suppressed',
      note: `Fewer than ${minimumCohortSize} ${cohortNoun} are behind this figure, so it is withheld rather than reduced.`,
      withheld: true,
    };
  }

  if (metric.status === 'unavailable' || metric.count === null) {
    return {
      value: 'None recorded',
      note: `The register holds no ${unitLabel}. That is what was entered, not a finding about what happened.`,
      withheld: false,
    };
  }

  return {
    value: String(metric.count),
    note: `Counted; at least ${minimumCohortSize} ${cohortNoun} are behind it.`,
    withheld: false,
  };
}

/**
 * A plain scheduling count, and the only place on any board surface where a
 * bare 0 is the honest answer. These buckets are never athlete-linked, so the
 * server hands them over as raw integers with no cohort floor and no null:
 * a zero here IS the measurement. It has to read as one, and it must not
 * borrow the vocabulary of the gated tiles above -- "Suppressed" means a
 * figure exists and is being kept back, which is the opposite claim.
 */
function countedDisplay(
  count: number | undefined,
  isLoading: boolean,
  unitLabel: string,
): TileDisplay {
  if (isLoading) {
    return { value: '...', note: 'Loading.', withheld: false };
  }

  if (count === undefined) {
    return { value: 'Not read', note: 'This count did not arrive.', withheld: false };
  }

  if (count === 0) {
    return {
      value: '0',
      note: `A counted zero: the register holds no ${unitLabel}. Scheduling counts carry no cohort floor, so this is a measurement and never a withheld figure.`,
      withheld: false,
    };
  }

  return {
    value: String(count),
    note: 'Counted from the register. Scheduling counts carry no cohort floor and are never withheld.',
    withheld: false,
  };
}

/* Law 7: a withheld figure is static ink -- a stamp driven into the page --
   and never a numeral, a blank, or a dash that a reader could take for a
   measurement. Same idiom as BoardSummaryPanel and the compliance register,
   so the three board surfaces say "withheld" the same way. */
function AggregateTile({ label, display }: {
  readonly label: string;
  readonly display: TileDisplay;
}) {
  return (
    <article className="stat">
      <h3 className="stat-label">{label}</h3>
      {display.withheld ? (
        <p>
          <span className="stamp stamp--flat">{display.value}</span>
        </p>
      ) : (
        <p className="stat-val">{display.value}</p>
      )}
      <p className="stat-note">{display.note}</p>
    </article>
  );
}

function SectionHeader({ title, blurb, read, measuredAt }: {
  readonly title: string;
  readonly blurb: string;
  readonly read: AggregateRead<unknown>;
  readonly measuredAt: string | null;
}) {
  return (
    <div className="space-y-[var(--s2)]">
      <h2 className="font-display text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{title}</h2>
      <p className="t-body max-w-[80ch]">{blurb}</p>
      <p className="t-data">
        {read.isLoading
          ? 'Loading...'
          : measuredAt
            ? `Read ${measuredAt}`
            : 'Read time unknown'}
      </p>
      {read.errorMessage ? (
        <p className="t-body flex items-center gap-[var(--s2)]">
          <span aria-hidden="true" className="text-[color:var(--brass-400)]">▲</span>
          <span>{read.errorMessage}</span>
        </p>
      ) : null}
    </div>
  );
}

export default function BoardAggregatesPage() {
  const volunteers = useBoardAggregate<VolunteerSummary>(
    VOLUNTEER_ENDPOINT,
    'Unable to load the volunteer aggregate.',
  );
  const competition = useBoardAggregate<ExternalCompetitionSummary>(
    COMPETITION_ENDPOINT,
    'Unable to load the external competition aggregate.',
  );
  const league = useBoardAggregate<WrestlingLeagueSummary>(
    LEAGUE_ENDPOINT,
    'Unable to load the wrestling league aggregate.',
  );

  const volunteerFloor = volunteers.summary?.minimumCohortSize ?? FALLBACK_MINIMUM_COHORT_SIZE;
  const competitionFloor = competition.summary?.minimumCohortSize ?? FALLBACK_MINIMUM_COHORT_SIZE;
  const leagueFloor = league.summary?.minimumCohortSize ?? FALLBACK_MINIMUM_COHORT_SIZE;

  const volunteerTiles = [
    { label: 'Active Volunteers', metric: volunteers.summary?.volunteersByStatus.active, unitLabel: 'active volunteers' },
    { label: 'Pending Volunteers', metric: volunteers.summary?.volunteersByStatus.pending, unitLabel: 'pending volunteers' },
    { label: 'Inactive Volunteers', metric: volunteers.summary?.volunteersByStatus.inactive, unitLabel: 'inactive volunteers' },
    { label: 'Joined In 30 Days', metric: volunteers.summary?.newVolunteers30Days, unitLabel: 'volunteers who joined in the last 30 days' },
  ];

  const competitionTiles = [
    { label: 'Competitions Planned', count: competition.summary?.competitionsByStatus.planned, unitLabel: 'planned competition' },
    { label: 'Competitions Completed', count: competition.summary?.competitionsByStatus.completed, unitLabel: 'completed competition' },
    { label: 'Competitions Cancelled', count: competition.summary?.competitionsByStatus.cancelled, unitLabel: 'cancelled competition' },
  ];

  const entryTiles = [
    { label: 'Entries Won', metric: competition.summary?.entriesByResult.won, unitLabel: 'entries with this result' },
    { label: 'Entries Lost', metric: competition.summary?.entriesByResult.lost, unitLabel: 'entries with this result' },
    { label: 'Entries Drawn', metric: competition.summary?.entriesByResult.draw, unitLabel: 'entries with this result' },
    { label: 'No Contest', metric: competition.summary?.entriesByResult.no_contest, unitLabel: 'entries with this result' },
  ];

  const seasonTiles = [
    { label: 'Seasons Planned', count: league.summary?.seasonsByStatus.planned, unitLabel: 'planned season' },
    { label: 'Seasons Active', count: league.summary?.seasonsByStatus.active, unitLabel: 'active season' },
    { label: 'Seasons Completed', count: league.summary?.seasonsByStatus.completed, unitLabel: 'completed season' },
  ];

  return (
    /* board ONLY, and deliberately narrower than its own layout: BoardRoleGate
       admits platform_owner, and every other board sub-page passes
       ['board', 'platform_owner']. All three routes behind this page gate on
       ['board'] alone, and volunteer-summary/route.test.ts pins that a
       platform_owner is refused ("this route is board-only, unlike
       board/summary"). Admitting one here would render a page whose every
       figure is a 403 -- a governance surface reporting nothing, for a reason
       the reader cannot see. The gate is the route's; this only stops the
       platform owner walking into a room with no floor. */
    <RoleSessionGate allowedRoles={['board']}>
      {/* No room modifier class here, on purpose, unlike the two sibling
          board pages. Rooms were retired as a VISUAL concept by owner decision
          2026-08-23: buildingMapRooms.test.ts no longer requires a page to
          paint the room its door files it under, and
          legacyVisualVocabulary.test.ts freezes the retired room-modifier
          vocabulary at the occurrence count measured that day (143) -- a
          ceiling the tree sits exactly on, so a new screen wearing one would
          spread a vocabulary that guard exists to shrink. The door in
          buildingMap.ts still files this surface under the board room; that is
          structural metadata, which the same decision kept deliberately. The
          ground below is the board room's own ink, the same pair the siblings
          set beside their modifier. */}
      <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto max-w-7xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow tracking-[0.22em]">Board Workspace</p>
            <h1 className="font-display text-[length:var(--t-2xl)] font-black text-[color:var(--bone-100)]">Program Aggregates</h1>
            <p className="t-body max-w-[80ch]">
              Volunteers, external competition and the wrestling league, counted across the whole organization. The
              board is not admitted to any of the three registers themselves; these counts are the whole of what this
              seat may see of them. No name, record, result or roster entry reaches this page.
            </p>
          </header>

          <section className="mat-paper mt-[var(--s5)] rounded-[var(--r-md)] p-[var(--s5)]">
            <h2 className="font-display text-[length:var(--t-sm)] font-black uppercase tracking-[0.08em] text-[color:var(--brass-800)]">Three figures, three different meanings</h2>
            <ul className="mt-[var(--s2)] max-w-[80ch] list-disc space-y-[var(--s2)] pl-[var(--s5)] text-[length:var(--t-sm)] leading-6">
              <li>
                <strong>A number, including 0.</strong> A measured count. Season and competition figures are
                organizational scheduling facts tied to no athlete, so a zero there is a real zero: the register holds
                none.
              </li>
              <li>
                <strong>A Suppressed stamp.</strong> A figure that exists and is being withheld, because fewer people
                stand behind it than the cohort floor the response reports. It is never shown reduced and never shown
                as a zero.
              </li>
              <li>
                <strong>None recorded.</strong> Nothing has been entered in that bucket. It is a statement about the
                register, not a finding about what happened in the gym.
              </li>
            </ul>
          </section>

          <section className="mt-[var(--s6)] space-y-[var(--s4)]">
            <SectionHeader
              title="Volunteers"
              blurb={`How many volunteers sit in each status, and how many joined in the last 30 days. Every bucket is gated: fewer than ${volunteerFloor} volunteers behind a figure and it is withheld. The board reads no volunteer record -- no name, no certification, no background-check status, no note.`}
              read={volunteers}
              measuredAt={volunteers.summary ? formatMeasuredAt(volunteers.summary.generatedAt) : null}
            />
            <div className="grid gap-[var(--s4)] md:grid-cols-2 lg:grid-cols-4">
              {volunteerTiles.map((tile) => (
                <AggregateTile
                  key={tile.label}
                  label={tile.label}
                  display={gatedDisplay(tile.metric, volunteerFloor, volunteers.isLoading, tile.unitLabel, 'volunteers')}
                />
              ))}
            </div>
          </section>

          <section className="mt-[var(--s6)] space-y-[var(--s4)]">
            <SectionHeader
              title="External Competition"
              blurb="How many competitions stand in the register by status, and how the entries resolved. Competition counts are scheduling facts and are reported as measured. Result counts are athlete-linked, so each one is gated on the athletes in that result bucket."
              read={competition}
              measuredAt={competition.summary ? formatMeasuredAt(competition.summary.generatedAt) : null}
            />
            <div className="grid gap-[var(--s4)] md:grid-cols-3">
              {competitionTiles.map((tile) => (
                <AggregateTile
                  key={tile.label}
                  label={tile.label}
                  display={countedDisplay(tile.count, competition.isLoading, tile.unitLabel)}
                />
              ))}
            </div>
            <div className="grid gap-[var(--s4)] md:grid-cols-2 lg:grid-cols-4">
              {entryTiles.map((tile) => (
                <AggregateTile
                  key={tile.label}
                  label={tile.label}
                  display={gatedDisplay(tile.metric, competitionFloor, competition.isLoading, tile.unitLabel, 'athletes')}
                />
              ))}
            </div>
          </section>

          <section className="mt-[var(--s6)] space-y-[var(--s4)]">
            <SectionHeader
              title="Wrestling League"
              blurb="Seasons by status, and how many athletes are currently rostered onto one. Season counts are scheduling facts and are reported as measured; the rostered-athlete count is gated like every other athlete figure the board sees."
              read={league}
              measuredAt={league.summary ? formatMeasuredAt(league.summary.generatedAt) : null}
            />
            <div className="grid gap-[var(--s4)] md:grid-cols-3">
              {seasonTiles.map((tile) => (
                <AggregateTile
                  key={tile.label}
                  label={tile.label}
                  display={countedDisplay(tile.count, league.isLoading, tile.unitLabel)}
                />
              ))}
            </div>
            <div className="grid gap-[var(--s4)] md:grid-cols-2">
              <AggregateTile
                label="Rostered Athletes"
                display={gatedDisplay(
                  league.summary?.rosteredAthletes,
                  leagueFloor,
                  league.isLoading,
                  'athletes rostered onto a season',
                  'athletes',
                )}
              />
            </div>
          </section>
        </div>
      </main>
    </RoleSessionGate>
  );
}
