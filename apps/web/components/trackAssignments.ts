export type TrackID =
  | 'non_contact'
  | 'usa_boxing'
  | 'a2p'
  | 'pro'
  | 'collegiate'
  | 'usa_masters'
  | 'spec_ops';

export interface TrackManifest {
  name: string;
  desc: string;
  focusWorkout: string[];
}

export interface AthleteProfile {
  id: string;
  label: string;
}

export type TrackAssignments = Record<string, TrackID[]>;

export const athleteProfiles: AthleteProfile[] = [
  { id: 'athlete-001', label: 'Athlete 001 - Youth Foundation' },
  { id: 'athlete-002', label: 'Athlete 002 - Competition Prep' },
  { id: 'athlete-003', label: 'Athlete 003 - Collegiate Candidate' },
];

export const trackManifests: Record<TrackID, TrackManifest> = {
  non_contact: {
    name: 'Non-Contact Track',
    desc: 'General athletic fitness, technical boxing biomechanics, and lifestyle accountability without live contact.',
    focusWorkout: [
      'Stance stability and core balance weight-distribution checks',
      '15 minutes of dynamic shadowboxing focusing on clean jab mechanics',
      'Reaction ball tracking responding to visual focus target changes',
      '10-minute lifestyle and personal discipline reflection block',
    ],
  },
  usa_boxing: {
    name: 'USA Boxing Track',
    desc: 'Amateur competitive track operating strictly under USA Boxing safety standards, red/blue books, and certified coach guidelines.',
    focusWorkout: [
      'Dynamic footwork agility and ring geometry movement drills',
      'Partner defensive blocking utilizing approved padded shields',
      'High-cadence punch output drills tracking extension and guard return',
      'Review of safe athletic travel policies and SafeSport boundaries',
    ],
  },
  a2p: {
    name: 'Amateur to Pro Track (A2P)',
    desc: 'Accelerated developmental track bridging high-level amateur skillsets with professional licensing requirements.',
    focusWorkout: [
      'Multi-round heavy bag intervals simulating professional rounds pacing',
      'Slipping under the cord line with immediate counter-punch delivery',
      'High-volume focus mitt combinations testing physical stamina limits',
      'Metabolic recovery control breathing between round intervals',
    ],
  },
  pro: {
    name: 'Pro Track',
    desc: 'Professional program monitoring high-volume training stress, round fatigue indexes, and recovery thresholds.',
    focusWorkout: [
      '12 rounds of targeted heavy bag drills utilizing complex punch combinations',
      'Anatomical defensive shell checks against high-intensity focus shots',
      'Reaction cue speed testing under severe localized muscle fatigue',
      'Post-workout joint cooling and soreness index mapping logs',
    ],
  },
  collegiate: {
    name: 'Collegiate Track',
    desc: 'Tailored for student-athletes. Enforces academic passing standards as a requirement for on-floor training access.',
    focusWorkout: [
      'Agility ladder footwork drills maintaining balance-width',
      'Dynamic high-guard partner counter-movement drills',
      'Conditioning sprints to maintain high athletic work-capacity',
      'Mandatory 30-minute academic study or homework block (Layer 14)',
    ],
  },
  usa_masters: {
    name: 'USA Masters Track',
    desc: 'Designed for competitive athletes aged 35+. Focuses on extended mobility prep, low-impact drills, and strict medical clearance logs.',
    focusWorkout: [
      'Mandatory 15-minute joint mobility and core activation warmup',
      'Technical guard blocking drills keeping impact forces controlled',
      'Targeted bag work focusing on timing rather than high anaerobic spikes',
      'Extended muscle cooldown and joint-soreness feedback mapping',
    ],
  },
  spec_ops: {
    name: 'Air Force SpecOps Track',
    desc: 'Specialized military prep track focused on tracking the 16 Task Dimensions and 11 Project Lifecycle statuses.',
    focusWorkout: [
      'Anatomical load carriage baseline pacing run',
      'Water confidence pool prep (Dry land breath control drills)',
      'Neuromuscular power tracking testing battery V1',
      'Decision-making response testing under high localized physical fatigue',
    ],
  },
};

export const allTrackIds = Object.keys(trackManifests) as TrackID[];

export function getDefaultTrackAssignments(): TrackAssignments {
  return {
    'athlete-001': ['non_contact', 'usa_boxing'],
    'athlete-002': ['usa_boxing', 'a2p', 'pro'],
    'athlete-003': ['non_contact', 'collegiate'],
  };
}

function sanitizeTracks(input: unknown): TrackID[] {
  if (!Array.isArray(input)) {
    return ['non_contact'];
  }

  const valid = input.filter((item): item is TrackID => typeof item === 'string' && allTrackIds.includes(item as TrackID));
  return valid.length > 0 ? valid : ['non_contact'];
}

export function normalizeTrackAssignments(input: unknown): TrackAssignments {
  const defaults = getDefaultTrackAssignments();
  if (!input || typeof input !== 'object') {
    return defaults;
  }

  const parsed = input as Record<string, unknown>;
  const normalized: TrackAssignments = {};

  for (const profile of athleteProfiles) {
    normalized[profile.id] = sanitizeTracks(parsed[profile.id]);
  }

  return normalized;
}

export function loadTrackAssignments(): TrackAssignments {
  return getDefaultTrackAssignments();
}

export function saveTrackAssignments(assignments: TrackAssignments) {
  void assignments;
}

export function readActiveAthleteProfileId() {
  return athleteProfiles[0].id;
}

export function saveActiveAthleteProfileId(profileId: string) {
  void profileId;
}
