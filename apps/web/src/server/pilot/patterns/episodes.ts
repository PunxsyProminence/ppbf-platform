/**
 * THE COUNTING UNIT IS THE ATTEMPT, NOT THE READING.
 *
 * Two coaches watching the same rep write two readings of one attempt. Counted
 * as two, they turn one rep into "seen twice" -- enough to clear the
 * one-rep-is-one-rep rule and to halve a recurrence interval -- when nothing
 * happened twice. Several reports of one attempt are not independent evidence
 * about the athlete; they are several looks at one piece of it.
 *
 * So readings are first grouped into EPISODES: readings that share session,
 * task context AND a non-empty `opportunityKey` (types.ts: "the one attempt
 * -- rep, round, exchange -- this reading is about") are one episode. A
 * reading with no key is an episode of its own, which leaves every caller
 * that never sets a key exactly where it was.
 *
 * What is counted per EPISODE: occurrences, counterexamples, sessions,
 * contexts, recency, recurrence trials, rate series, transfer, retention,
 * regression. What stays per READING: who looked (observers, human or model,
 * film or eyes), disagreement, video contradiction and observer reliability --
 * those are claims about the looking, and need every look.
 *
 * A DISPUTED episode -- readings of both polarities -- counts as neither. The
 * readings' own disagreement is still raised from the readings (evidence.ts
 * detectObserverDisagreement / detectVideoContradiction), which is what makes
 * the candidate CONTESTED; counting either side as well would decide the
 * dispute the module exists to leave to a person.
 *
 * Pure and deterministic, like everything in this directory. Readings are
 * assumed already admitted (evidence.ts admitObservations): superseded
 * readings are gone, so one observer's revised call appears once.
 */

import type {
  AttributionCertainty,
  BehaviourObservation,
  ObservationAttribution,
  PatternEvidenceSummary,
} from './types';

/** Source types that constitute video corroboration -- the same set as evidence.ts VIDEO_SOURCE_TYPES. */
const VIDEO_SOURCE_TYPES: ReadonlySet<string> = new Set(['computer_vision']);

export interface EpisodeCollapse {
  /** One reading per undisputed episode, carrying the episode's polarity. */
  readonly episodes: readonly BehaviourObservation[];
  /** Every reading of each undisputed episode, keyed by the representative's observationId. */
  readonly readingsOf: ReadonlyMap<string, readonly BehaviourObservation[]>;
  /** Episodes whose readings disagree on polarity, by episode key. */
  readonly disputedEpisodeKeys: readonly string[];
}

/**
 * The attempt a reading is about: session, task and key; or the reading itself
 * when it names none. The key is taken exactly as evidence.ts takes it (any
 * non-empty string, untrimmed), so this grouping and the disagreement
 * detectors' grouping are the same grouping.
 */
export function episodeKeyOf(reading: BehaviourObservation): string {
  const key = reading.opportunityKey;
  return typeof key === 'string' && key.length > 0
    ? JSON.stringify(['attempt', reading.sessionId, reading.taskContextKey, key])
    : JSON.stringify(['reading', reading.observationId]);
}

const CERTAINTY_ORDER: readonly AttributionCertainty[] = ['stated', 'probable', 'uncertain'];

/**
 * Whose failure the attempt was, across every reading of it: the target only
 * when every reading names the same one, 'unresolved' otherwise, at the least
 * certain reading's certainty. One coach's call never hides another's.
 */
function mergedAttribution(readings: readonly BehaviourObservation[]): ObservationAttribution {
  const targets = new Set(readings.map((reading) => reading.attribution.target));
  const certainty = readings
    .map((reading) => reading.attribution.certainty)
    .reduce((least, next) => (CERTAINTY_ORDER.indexOf(next) > CERTAINTY_ORDER.indexOf(least) ? next : least));
  return targets.size === 1
    ? { target: readings[0].attribution.target, certainty }
    : { target: 'unresolved', certainty: 'uncertain' };
}

function sortKey(reading: BehaviourObservation): string {
  return `${reading.observedAt}|${reading.observationId}`;
}

export function collapseToEpisodes(readings: readonly BehaviourObservation[]): EpisodeCollapse {
  const groups = new Map<string, BehaviourObservation[]>();
  for (const reading of [...readings].sort((left, right) => sortKey(left).localeCompare(sortKey(right)))) {
    const key = episodeKeyOf(reading);
    const group = groups.get(key);
    if (group) group.push(reading);
    else groups.set(key, [reading]);
  }

  const episodes: BehaviourObservation[] = [];
  const readingsOf = new Map<string, readonly BehaviourObservation[]>();
  const disputedEpisodeKeys: string[] = [];
  for (const [key, group] of groups) {
    if (new Set(group.map((reading) => reading.polarity)).size > 1) {
      disputedEpisodeKeys.push(key);
      continue;
    }
    // The earliest person's reading stands for the episode where there is
    // one: it carries the context the episode is counted under, and the
    // attribution of ALL its readings (mergedAttribution). Who else looked is
    // carried in readingsOf, not lost.
    const first = group.find((reading) => reading.interpretation === 'human_observed') ?? group[0];
    const representative = group.length === 1 ? first : Object.freeze({ ...first, attribution: mergedAttribution(group) });
    episodes.push(representative);
    readingsOf.set(representative.observationId, Object.freeze([...group]));
  }

  return Object.freeze({
    episodes: Object.freeze(episodes),
    readingsOf,
    disputedEpisodeKeys: Object.freeze(disputedEpisodeKeys),
  });
}

/**
 * The evidence vector over episodes, with its "who looked" dimensions taken
 * from every reading of the occurrence episodes: distinct observers, how many
 * episodes a person saw, how many only a model proposed, how many film
 * corroborates, and how many kinds of source looked. Everything else is the
 * per-episode summary as given.
 */
export function withReadingDimensions(
  perEpisode: PatternEvidenceSummary,
  collapse: EpisodeCollapse,
): PatternEvidenceSummary {
  const occurrenceReadings = collapse.episodes
    .filter((episode) => episode.polarity === 'occurrence')
    .map((episode) => collapse.readingsOf.get(episode.observationId) ?? [episode]);
  const allReadings = occurrenceReadings.flat();
  return Object.freeze({
    ...perEpisode,
    distinctObservers: new Set(
      allReadings
        .map((reading) => reading.observerAccountId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ).size,
    distinctSourceTypes: new Set(allReadings.map((reading) => reading.source.type)).size,
    humanObservedCount: occurrenceReadings
      .filter((readings) => readings.some((reading) => reading.interpretation === 'human_observed')).length,
    aiProposedCount: occurrenceReadings
      .filter((readings) => readings.every((reading) => reading.interpretation === 'ai_proposed')).length,
    videoCorroboratedCount: occurrenceReadings
      .filter((readings) => readings.some((reading) => VIDEO_SOURCE_TYPES.has(reading.source.type))).length,
  });
}
