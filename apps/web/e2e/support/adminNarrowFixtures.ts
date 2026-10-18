/* Stub API payloads for nine admin pages, built to overflow a 375px screen.

   Each entry answers every GET (or read-on-mount POST) its page makes when it
   loads, in the exact shape that page parses: field names, nesting and the
   wrapper key. Values are deliberately long -- hyphenated names, long guardian
   emails, uuid-like ids, ISO timestamps, sentence-length notes -- and the rows
   between them cover every enum or status the page renders differently.

   Used through installPilotApi(page, { session: { role: 'organization_admin' }, routes }).
   `expectText` appears exactly once, and only after the stubbed data renders. */

export interface AdminNarrowPage {
  readonly page: string;
  readonly path: string;
  readonly routes: Record<string, unknown>;
  readonly expectText: string;
}

/* ---------------------------------------------------------------- builders */

const NAMES = [
  'Maximiliano Alejandro Fernández-Castellanos',
  'Anastasia Konstantinovna Volkonskaya-Whitfield',
  'Oluwaseun Adebayo-Montgomery Okonkwo-Ellsworth',
  'Bartholomew Fitzgerald Vanderwoude-Abernathy III',
  'Guadalupe Esperanza Rodríguez de la Fuente-Ortiz',
  'Thanh-Huong Nguyen-Kowalczyk Abernathy-Pemberton',
  'Christopher-Jean Baptiste Delacroix-Ramírez',
  'Wilhelmina Josephine Featherstonehaugh-Nakamura',
  'Persephone Alexandrina Montgomery-Szczepański',
  'Ignatius Leopold Wójcik-Habsburg-Lothringen',
] as const;

const GUARDIAN_NAMES = [
  'Esperanza Dolores Fernández-Castellanos de Villanueva',
  'Konstantin Mikhailovich Volkonsky-Whitfield',
  'Adebayo Oluwaseun Okonkwo-Ellsworth Sr.',
  'Margaretha Cornelia Vanderwoude-Abernathy',
  'Rosalinda Inmaculada de la Fuente-Ortiz',
  'Kowalczyk Thanh-Binh Nguyen-Pemberton',
  'Marie-Claire Antoinette Delacroix-Ramírez',
  'Hiroshi Alistair Featherstonehaugh-Nakamura',
] as const;

/** Deterministic 32 hex digits from a seed, formatted as a v4-looking uuid. */
function uuidLike(seed: number): string {
  let x = (seed * 2654435761) >>> 0;
  let hex = '';
  for (let i = 0; i < 32; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    hex += ((x >>> 16) & 0xf).toString(16);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function id(prefix: string, seed: number): string {
  return `${prefix}-${uuidLike(seed)}`;
}

function athleteId(i: number): string {
  return id('ath', 1000 + i);
}

/** An ISO timestamp i hours-and-a-bit before a fixed instant. */
function iso(i: number, baseDay = 10): string {
  return new Date(Date.UTC(2026, 9, baseDay, 23, 47, 13) - i * 26 * 3600 * 1000 - i * 7 * 60 * 1000).toISOString();
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function guardianEmail(i: number): string {
  return `guardian.of.${slug(NAMES[i])}@longfamilydomain.example`;
}

const NOTES = [
  'Reported sharp pain in the left wrist after the second round of pad work and stopped on his own. Coach on duty applied ice and called the guardian, who will book a follow-up with the family physician this week.',
  'Athlete mentioned during cool-down that she has been skipping meals before evening sessions to make weight for the regional qualifier. Nutrition conversation started; guardian has not yet been reached by phone.',
  'Pattern scan found four near-miss reports in eleven days, all during unsupervised bag work after 8pm. Floor supervision schedule for late sessions needs to be reviewed before the holiday block starts.',
  'Guardian consent form on file is the 2024 version, which does not cover video. The updated form was emailed twice and handed over at pickup once; no signed copy has come back yet.',
  'Sparring partner assignment paired a 14-year-old with an adult volunteer outside the documented weight band. Session was stopped by the head coach within two minutes and both athletes were checked over.',
  'Athlete voice submission described feeling pressured to keep training through a reported headache. Head coach and the safeguarding lead met the athlete and guardian together the following afternoon.',
  'Medical clearance letter expired on the first of the month and the renewal appointment is not until the twenty-second. Contact work is paused until the new letter is uploaded and reviewed by staff.',
  'Video uploaded from the tournament weekend shows two other minors in frame whose guardians have only consented to photos. The uploader has been asked to re-cut the footage before it is resubmitted.',
] as const;

/* ------------------------------------------------------- athlete-consent */

const CONSENT_STATUSES = ['signed', 'withdrawn', 'declined', null, ' Signed ', 'pending', 'expired', 'signed'] as const;

function guardianConsentRow(athlete: number, g: number) {
  const status = CONSENT_STATUSES[(athlete + g) % CONSENT_STATUSES.length];
  const consented = status === 'signed' || status === ' Signed ';
  return {
    parent_id: g % 3 === 2 ? id('par-paper', athlete * 10 + g) : id('par', athlete * 10 + g),
    parent_name: GUARDIAN_NAMES[(athlete + g * 3) % GUARDIAN_NAMES.length],
    has_login: g % 3 !== 2,
    status,
    consented,
    covers_video: status === null ? null : consented ? g % 2 === 0 : false,
    public_use_allowed: status === null ? null : consented && athlete % 2 === 0,
    signed_at: consented ? iso(athlete * 3 + g, 1) : null,
  };
}

function athleteConsentItems() {
  return NAMES.map((name, i) => {
    // Rows 0-7 are missing consent (the default "missing" filter shows them);
    // rows 8-9 are fully consented (visible under "Consent on file").
    const guardianCount = i === 3 ? 0 : i >= 8 ? 2 : (i % 3) + 1;
    const perGuardian = Array.from({ length: guardianCount }, (_, g) => {
      const row = guardianConsentRow(i, g);
      if (i >= 8) {
        return { ...row, status: 'signed', consented: true, covers_video: true, public_use_allowed: true, signed_at: iso(g, 2) };
      }
      return row;
    });
    // A missing row always has at least one guardian not consented.
    if (i < 8 && perGuardian.length > 0 && perGuardian.every((g) => g.consented)) {
      perGuardian[0] = { ...perGuardian[0], status: 'withdrawn', consented: false, covers_video: false, public_use_allowed: false, signed_at: null };
    }
    const missing = perGuardian.filter((g) => !g.consented).length;
    return {
      athlete_id: athleteId(i),
      athlete_name: name,
      consent_ok: i >= 8,
      guardian_count: guardianCount,
      missing_guardian_count: missing,
      per_guardian: perGuardian,
    };
  });
}

/* ----------------------------------------------------- compliance-center */

const VIOLATION_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const VIOLATION_STATUSES = ['new', 'acknowledged', 'escalated', 'resolved', 'dismissed'] as const;
const RULE_NAMES = [
  'Guardian media consent must be current before any footage is distributed',
  'Medical clearance must be on file before contact sparring',
  'Two-adult rule for every session with a minor present on the floor',
  'Weight-band matching for sparring partners under eighteen',
  'Concussion return-to-play protocol stage sign-off',
  'Annual waiver renewal within thirty days of the anniversary date',
  'Mandatory rest period after a reported head impact',
  'Coach certification must be current to run unsupervised sessions',
] as const;

function complianceViolations() {
  return Array.from({ length: 8 }, (_, i) => ({
    violation_id: id('vio', 2000 + i),
    rule_id: id('rule', 2100 + i),
    athlete_id: athleteId(i),
    severity: VIOLATION_SEVERITIES[i % VIOLATION_SEVERITIES.length],
    status: VIOLATION_STATUSES[i % VIOLATION_STATUSES.length],
    created_at: iso(i),
    description: NOTES[i],
    // Row 7 has neither joined name, so the ids are what renders.
    athlete_name: i === 7 ? null : NAMES[i],
    rule_name: i === 7 ? null : RULE_NAMES[i],
  }));
}

const SHADOW_STATUSES = ['pending', 'approved', 'completed', 'denied'] as const;

function shadowDeletionRequests() {
  return Array.from({ length: 8 }, (_, i) => {
    const status = SHADOW_STATUSES[i % SHADOW_STATUSES.length];
    const handled = status === 'completed' || status === 'denied';
    return {
      requestId: id('sdr', 2200 + i),
      accountId: `acct-athlete-${slug(NAMES[i]).replace(/\./g, '-')}-${uuidLike(2300 + i).slice(0, 8)}`,
      status,
      requestedAt: iso(i + 2),
      completedAt: handled ? iso(i) : null,
      processedBy: handled ? id('acct-admin', 2400 + i) : null,
      conversationsPending: status === 'completed' ? 0 : i === 1 ? 1 : 37 + i * 11,
    };
  });
}

/* ----------------------------------------------------------- escalations */

const ESCALATION_SOURCES = [
  'near_miss',
  'pain_report',
  'safety_gate_evaluation',
  'repeated_pattern',
  'athlete_voice',
  'training_hold',
  'incident',
  'video_scan',
  'compliance_violation',
  'shadow_disclosure',
] as const;
const ESCALATION_SEVERITIES = ['critical', 'high', 'moderate', 'low'] as const;
const ESCALATION_STATUSES = ['open', 'open', 'acknowledged', 'open', 'resolved', 'acknowledged', 'open', 'resolved'] as const;

function escalationRows() {
  // One row per source_type, so every Source label renders.
  return ESCALATION_SOURCES.map((source, i) => ({
    escalation_id: id('esc', 3000 + i),
    source_type: source,
    athlete_id: athleteId(i),
    severity: ESCALATION_SEVERITIES[i % ESCALATION_SEVERITIES.length],
    reason: NOTES[i % NOTES.length],
    status: ESCALATION_STATUSES[i % ESCALATION_STATUSES.length],
    escalated_to_role: i % 2 === 0 ? 'organization_admin' : 'coach',
    created_at: iso(i),
  }));
}

/* -------------------------------------------------------------- feedback */

const TRIAGE_STATUSES = ['new', 'triaged', 'planned', 'declined', 'done'] as const;
const FEEDBACK_KINDS = ['bug', 'frustration', 'idea', 'other'] as const;
const SUBMITTER_ROLES = ['athlete', 'parent', 'coach', 'staff', 'volunteer', 'athlete', 'parent', 'coach'] as const;

function feedbackItems() {
  return Array.from({ length: 8 }, (_, i) => {
    const safeguarding = i < 3;
    return {
      submission_id: id('fb', 4000 + i),
      organization_id: id('org', 1),
      organization_name: 'Punxsutawney Prominence Boxing & Fitness Community Association',
      submitted_by_role: SUBMITTER_ROLES[i],
      submitter_name: i === 6 ? null : i < 5 ? NAMES[i] : GUARDIAN_NAMES[i],
      kind: safeguarding ? 'other' : FEEDBACK_KINDS[i % FEEDBACK_KINDS.length],
      // Row 2 is a safeguarding row with no text, which the page states as withheld.
      body: i === 2 ? null : NOTES[i],
      route: safeguarding ? 'safeguarding' : 'product',
      triage_status: TRIAGE_STATUSES[i % TRIAGE_STATUSES.length],
      triage_note:
        i % 2 === 1
          ? 'Spoke with the family at Thursday pickup and agreed a follow-up plan. The head coach will check in again after the next two sessions and record the outcome here.'
          : null,
      created_at: iso(i),
    };
  });
}

/* ---------------------------------------------------------- safety-flags */

const FLAG_CODES = [
  'concussion_rest_period_not_yet_elapsed',
  'medical_clearance_missing_for_contact_sparring',
  'no_contact_hold_active_from_guardian_request',
  'load_spike_over_forty_percent_week_on_week',
  'overtraining_pattern_three_consecutive_weeks',
  'certification_lapsed_supervising_coach',
  'minor_note_unreviewed_after_seventy_two_hours',
  'weight_cut_rate_exceeds_guidance_for_minors',
] as const;
const FLAG_SEVERITIES = ['blocking_display', 'attention', 'advisory'] as const;
const TRIGGERED_BY = ['system_scheduled_scan', 'human_entry', 'system', 'guardian_report_intake'] as const;

function safetyFlags() {
  return Array.from({ length: 8 }, (_, i) => ({
    flag_id: id('flag', 5000 + i),
    athlete_id: i === 5 ? null : athleteId(i),
    flag_class: i % 3 === 0 ? 'external_rule' : 'system_guidance',
    flag_code: FLAG_CODES[i],
    severity: FLAG_SEVERITIES[i % FLAG_SEVERITIES.length],
    triggered_by: TRIGGERED_BY[i % TRIGGERED_BY.length],
    trigger_detail: i === 4 ? '' : NOTES[i],
    evidence_basis: i % 2 === 0 ? 'state_athletic_commission_rule_2025_14' : 'internal_coaching_guidance_v3',
    created_at: iso(i),
  }));
}

/* --------------------------------------------------------- safety-review */

const HOLD_SCOPES = ['all_training', 'contact_only', 'conditioning_only'] as const;
const HOLD_REASONS = [
  'medical_concussion_protocol_stage_two',
  'behavioral',
  'administrative_missing_paperwork',
  'medical',
  'guardian_requested_pause_pending_review',
  'other',
  'safeguarding_referral_open',
  'administrative',
] as const;
const GATE_NAMES = [
  'medical_clearance_current_for_contact',
  'guardian_consent_on_file',
  'weight_band_within_tolerance',
  'concussion_return_to_play_stage',
  'two_adult_supervision_present',
  'waiver_general_current',
  'rest_period_after_head_impact',
  'sparring_partner_age_band',
] as const;

function safetyReview() {
  // Each list names a different athlete in its first row, so the expectText
  // (row 0 of holds) appears exactly once on the page.
  const nameAt = (i: number, offset: number) => (i === 6 ? null : NAMES[1 + ((i + offset) % (NAMES.length - 1))]);
  return {
    ok: true,
    openHolds: Array.from({ length: 8 }, (_, i) => ({
      hold_id: id('hold', 6000 + i),
      athlete_id: athleteId(i),
      athlete_name: i === 6 ? null : NAMES[i],
      scope: HOLD_SCOPES[i % HOLD_SCOPES.length],
      reason_category: HOLD_REASONS[i],
      placed_by_role: i % 2 === 0 ? 'organization_admin' : 'coach',
      placed_at: iso(i),
    })),
    failingGates: Array.from({ length: 8 }, (_, i) => ({
      athlete_id: athleteId(i + 1),
      athlete_name: nameAt(i, 1),
      gate_name: GATE_NAMES[i],
      outcome: i % 2 === 0 ? 'blocked' : 'flagged',
      evaluated_at: iso(i),
    })),
    openEscalations: Array.from({ length: 8 }, (_, i) => ({
      escalation_id: id('esc', 6100 + i),
      athlete_id: athleteId(i + 2),
      athlete_name: nameAt(i, 2),
      source_type: ESCALATION_SOURCES[i],
      severity: ESCALATION_SEVERITIES[i % ESCALATION_SEVERITIES.length],
      status: i % 3 === 2 ? 'acknowledged' : 'open',
      created_at: iso(i),
    })),
    openViolations: Array.from({ length: 8 }, (_, i) => ({
      violation_id: id('vio', 6200 + i),
      athlete_id: athleteId(i + 3),
      athlete_name: nameAt(i, 3),
      severity: VIOLATION_SEVERITIES[i % VIOLATION_SEVERITIES.length],
      status: (['new', 'acknowledged', 'escalated'] as const)[i % 3],
      created_at: iso(i),
    })),
    // Lane U2 (A-2): the fifth feed. Long codes and an account subject
    // (athlete_id null) are the rows most likely to push the page sideways.
    openFlags: Array.from({ length: 8 }, (_, i) => ({
      flag_id: id('flag', 6300 + i),
      athlete_id: i === 5 ? null : athleteId(i + 4),
      athlete_name: i === 5 ? null : nameAt(i, 4),
      flag_code: (['medical_clearance_missing_for_contact_sparring', 'concussion_rest_period_not_elapsed', 'guardian_consent_expired'] as const)[i % 3],
      flag_class: i % 2 === 0 ? 'external_rule' : 'system_guidance',
      severity: (['blocking_display', 'attention', 'advisory'] as const)[i % 3],
      created_at: iso(i),
    })),
    violationsReadLimit: 200,
    // True renders the "read from the N most recently filed only" notice.
    violationsTruncated: true,
  };
}

/* ------------------------------------------------------ video-compliance */

const VIDEO_TITLES = [
  'Regional Golden Gloves Qualifier — Semifinal, Round Two, Corner View (Unedited)',
  'Saturday Open Gym Technique Clinic: Slipping the Jab and Countering to the Body',
  'Junior Olympic Trials Weigh-In and Warm-Up Footage, Ring Three Camera',
  'Parent Night Demonstration Bout — Exhibition Rules, Headgear and 16oz Gloves',
  'Footwork Ladder Drill Progression, Weeks One Through Six, Side-by-Side Comparison',
  'Community Fundraiser Highlight Reel With Sponsor Cards and Crowd Shots',
  'Heavy Bag Conditioning Circuit, Full Forty-Minute Session, Wide Angle',
  'Tournament Weekend Recap — Travel Team, Hotel Lobby and Venue Arrival',
] as const;
const CHECK_STATUSES = ['pending', 'manual_review', 'passed', 'failed'] as const;
const PLAYBACK_BLOCKED = [null, 'consent_withdrawn', 'photo_only', 'consent_unverified'] as const;

function videoBase(i: number, seedBase: number) {
  return {
    publication_id: id('pub', seedBase + i),
    title: i === 7 && seedBase === 7300 ? '' : VIDEO_TITLES[i],
    description: NOTES[(i + seedBase) % NOTES.length],
    athlete_id: athleteId(i),
    // Never NAMES[0]: that name belongs to the first pending row alone.
    athlete_name: i === 5 ? null : NAMES[1 + ((i + seedBase / 100) % (NAMES.length - 1))],
    uploader_account_id: id('acct-coach', seedBase + 50 + i),
    uploader_name: i === 3 ? null : `Coach ${GUARDIAN_NAMES[(i + 2) % GUARDIAN_NAMES.length]}`,
    created_at: iso(i),
  };
}

function videoCompliance() {
  return {
    ok: true,
    items: Array.from({ length: 8 }, (_, i) => {
      const blocked = PLAYBACK_BLOCKED[i % PLAYBACK_BLOCKED.length];
      return {
        ...videoBase(i, 7000),
        // Pending rows name their athlete by index so the expectText is unique.
        athlete_name: i === 5 ? null : NAMES[i],
        compliance_check_status: CHECK_STATUSES[i % CHECK_STATUSES.length],
        previous_review_note:
          i % 4 === 1
            ? 'Please blur the two athletes in the background of the second minute; their guardians have only consented to still photographs. Resubmit once the re-cut is uploaded.'
            : null,
        // Same-origin, non-API path: the player shows its own failure instead of
        // reaching out to the network.
        stream_url: blocked === null ? `/e2e-fixture-media/${id('blob', 7100 + i)}.mp4` : null,
        playback_blocked: blocked,
      };
    }),
    drafts: Array.from({ length: 8 }, (_, i) => videoBase(i, 7200)),
    published: Array.from({ length: 8 }, (_, i) => videoBase(i, 7300)),
    retracted: Array.from({ length: 8 }, (_, i) => videoBase(i, 7400)),
  };
}

/* --------------------------------------------------------- waiver-status */

const WAIVER_STATUS = ['signed', 'declined', 'withdrawn', 'missing'] as const;
const TONIGHT_ANSWERS = ['cleared', 'cleared_to_train', 'cleared_no_contact', 'not_cleared', 'unavailable'] as const;
const MEDICAL_STATUSES = ['cleared', 'restricted', 'not_cleared', 'pending', 'cleared_expired', 'no_record'] as const;

function waiverItems() {
  return NAMES.map((name, i) => {
    // Rows 0-7: active and missing at least one paper (the default view).
    // Row 8: all signed. Row 9: inactive.
    const complete = i === 8;
    const waivers = {
      general: complete ? 'signed' : WAIVER_STATUS[i % 4],
      medical_release: complete ? 'signed' : WAIVER_STATUS[(i + 1) % 4],
      photo_media: complete ? 'signed' : WAIVER_STATUS[(i + 2) % 4],
      travel: complete ? 'signed' : WAIVER_STATUS[(i + 3) % 4],
    } as const;
    const answer = TONIGHT_ANSWERS[i % TONIGHT_ANSWERS.length];
    const hold =
      i % 4 === 0
        ? null
        : i % 4 === 3
          ? 'unavailable'
          : {
              scope: HOLD_SCOPES[i % HOLD_SCOPES.length],
              athlete_explanation:
                'You are on a short break from contact work while we wait for your doctor to sign the return-to-play form. You can still do footwork, bag work and conditioning with your group.',
              lift_condition_text:
                'A signed stage-four return-to-play letter from the treating physician, reviewed by the head coach and recorded on your file.',
              expires_at: i % 2 === 0 ? iso(-10 - i) : null,
            };
    return {
      athlete_id: athleteId(i),
      athlete_name: name,
      active_flag: i !== 9,
      waivers,
      // Row 7 sends no tonight answer at all, which the page shows as unavailable.
      ...(i === 7
        ? {}
        : {
            tonight: {
              answer,
              hold,
              medical:
                i === 4
                  ? 'unavailable'
                  : {
                      status: MEDICAL_STATUSES[i % MEDICAL_STATUSES.length],
                      current: i % 6 === 0,
                      expires_at: i % 3 === 2 ? null : iso(i % 2 === 0 ? -40 : 20),
                    },
              waivers: (['general', 'medical_release', 'photo_media', 'travel'] as const).map((type) => ({
                type,
                status: waivers[type],
                recorded_on: waivers[type] === 'missing' ? null : iso(30 + i).slice(0, 10),
              })),
              media_consent:
                i === 6 ? { basis: 'adult_own_consent', own: 'none', outside_gym: false } : { basis: 'guardian', status: waivers.photo_media },
              open_violations: i === 5 ? 'unavailable' : i % 3,
            },
          }),
    };
  });
}

/* ----------------------------------------------------------------- people */

const MEMBER_ROLES = [
  'organization_admin',
  'coach',
  'coach',
  'staff',
  'volunteer',
  'parent',
  'parent',
  'parent',
  'athlete',
  'athlete',
] as const;

function peopleMembers() {
  return MEMBER_ROLES.map((role, i) => {
    const isAthlete = role === 'athlete';
    return {
      account_id: id(`acct-${role.replace('_', '-')}`, 8000 + i),
      // Row 7 (a parent) has no email; athletes sign in by account id and PIN.
      login_email: isAthlete || i === 7 ? null : i >= 5 ? guardianEmail(i) : `${slug(NAMES[i])}@punxsutawney-prominence-boxing.example`,
      auth_provider: isAthlete ? 'ppbf_local' : 'microsoft',
      role,
      athlete_id: isAthlete ? athleteId(i) : null,
      // Row 4 (volunteer) is deactivated.
      active_flag: i !== 4,
      has_pin: isAthlete ? i === 9 : false,
      membership_active: i !== 4,
    };
  });
}

function peopleGuardianLinks() {
  // Parent row 5 sees two athletes, row 6 one, row 7 none (stranded guardian).
  const parent5 = id('acct-parent', 8005);
  const parent6 = id('acct-parent', 8006);
  return [
    { account_id: parent5, parent_id: id('par', 8105), athlete_id: athleteId(8), athlete_full_name: NAMES[8], relationship_to_athlete: 'mother' },
    { account_id: parent5, parent_id: id('par', 8105), athlete_id: athleteId(2), athlete_full_name: NAMES[2], relationship_to_athlete: 'guardian' },
    { account_id: parent6, parent_id: id('par', 8106), athlete_id: athleteId(9), athlete_full_name: NAMES[9], relationship_to_athlete: 'grandparent' },
  ];
}

function pinDirectory() {
  return NAMES.slice(0, 8).map((name, i) => ({
    athlete_id: athleteId(i),
    full_name: name,
    // Half have no login yet, which is what the "existing athlete" picker lists.
    account_id: i % 2 === 0 ? id('acct-athlete', 8200 + i) : null,
    account_active: i % 2 === 0 ? i !== 4 : null,
    has_pin: i % 4 === 0,
    account_updated_at: i % 2 === 0 ? iso(i) : null,
  }));
}

/* ------------------------------------------------------------------ export */

/* The global header (components/GlobalRoleHeader.tsx -> SafetyAttentionBadge)
   reads /api/pilot/escalations?status=open on every admin page. Answering it
   with the open rows gives the header its real badge, as wide as it gets. */
const HEADER_ROUTES = {
  '/api/pilot/escalations': { ok: true, escalations: escalationRows().filter((row) => row.status === 'open') },
} as const;

export const ADMIN_NARROW_PAGES: ReadonlyArray<AdminNarrowPage> = [
  {
    page: 'athlete-consent',
    path: '/admin/athlete-consent',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/admin/athlete-consent': { ok: true, items: athleteConsentItems() },
    },
    expectText: NAMES[0],
  },
  {
    page: 'compliance-center',
    path: '/admin/compliance-center',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/compliance/violations': { items: complianceViolations(), limit: 50 },
      '/api/pilot/admin/shadow-data-requests': { ok: true, items: shadowDeletionRequests() },
    },
    expectText: `Athlete: ${NAMES[0]}`,
  },
  {
    page: 'escalations',
    path: '/admin/escalations',
    routes: {
      ...HEADER_ROUTES,
      // The page (and the header badge) ask for ?status=open on mount. This
      // overrides HEADER_ROUTES and answers every status at once, so all three
      // action states and all nine source labels render in one view.
      '/api/pilot/escalations': { ok: true, escalations: escalationRows() },
      // The Athlete column names the athlete (UXB-12): the long names are
      // what this width check is for.
      '/api/pilot/athletes/list': {
        items: ESCALATION_SOURCES.map((_, i) => ({ athlete_id: athleteId(i), full_name: NAMES[i % NAMES.length] })),
      },
    },
    expectText: NAMES[0],
  },
  {
    page: 'feedback',
    path: '/admin/feedback',
    routes: {
      ...HEADER_ROUTES,
      // POST on mount (a read with a body), answered the same way.
      '/api/pilot/feedback/list': {
        ok: true,
        scope: 'organization',
        organization_id: id('org', 1),
        items: feedbackItems(),
      },
    },
    expectText: NAMES[0],
  },
  {
    page: 'safety-flags',
    path: '/admin/safety-flags',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/safety-flags': { flags: safetyFlags() },
    },
    expectText: FLAG_CODES[0],
  },
  {
    page: 'safety-review',
    path: '/admin/safety-review',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/admin/safety-review': safetyReview(),
    },
    expectText: NAMES[0],
  },
  {
    page: 'video-compliance',
    path: '/admin/video-compliance',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/admin/video-compliance': videoCompliance(),
    },
    expectText: NAMES[0],
  },
  {
    page: 'waiver-status',
    path: '/admin/waiver-status',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/admin/waiver-status': { ok: true, items: waiverItems() },
    },
    expectText: NAMES[0],
  },
  {
    page: 'people',
    path: '/admin/people',
    routes: {
      ...HEADER_ROUTES,
      '/api/pilot/admin/staff': {
        ok: true,
        organization_id: id('org', 1),
        members: peopleMembers(),
        guardian_links: peopleGuardianLinks(),
      },
      '/api/pilot/admin/athlete-pin-directory': { ok: true, items: pinDirectory() },
    },
    expectText: guardianEmail(5),
  },
];
