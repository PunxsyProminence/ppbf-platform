// Readiness sweep (lane RS, pilot dry-run blocker B3): every workout template
// in the COMMITTED seed data, run through the issue's own read-only plan.
//
// WHAT IS REAL HERE. planTemplateIssue (workoutTemplates.ts) runs unchanged:
// the issue's own plan, the one the issue writer and the pre-issue list
// (U1-ISSUE) both call. With it run the plan's refusal rules: typed steps
// (TYPED_STEP_REASON), adoptionReadiness with the floor test taken as met
// (Jason 2026-10-11 "B", #1473), the difficulty vocabulary, and two drills of
// one template sharing a name. Nothing of that logic is restated in this file.
// The writer (issueWorkoutTemplate) also refuses two things before the plan:
// a template that is not current, which a fresh load never leaves, and a
// template with no steps, which a case below rules out in the committed data.
//
// WHAT IS FAKED, AND WHY IT IS THE STATE OF A FRESH LOAD. The plan reads the
// gym's library through drillLibraryV3 and ./db. Those reads are answered from
// the committed CSVs under apps/web/seed-data/, as the content-import core
// would leave them after loading those files into an empty gym:
//   - getDrillWithDetail: the committed drill row with its committed scale
//     levels, own stop rules and cues. `active` and `superseded_at` are system
//     columns the loader decides (specs/drills.ts systemColumn('active', 'true'));
//     a drill loaded for the first time is active and current.
//   - listReferenceLifecycles: 'available' (no gym drill adopted from it) for
//     every library drill; a drill id not in the library has no lifecycle, as
//     the real read returns none, and the plan names it unreadable.
//   - getOtherVersionAdoption: none; the gym runs no drill yet.
//   - the plan's one read of pilot.drills (names the gym's active drills hold):
//     none.
// What this does NOT establish: the state of any real database. A gym that
// has adopted, retired or edited drills in the app (staging, production) can
// be refused for reasons a fresh load cannot show (the cue rule on an adopted
// drill, a retired adoption, a name already held), and a drill whose current
// version holds a coach's in-app edit is not revised by a load (inAppEdits.ts).
//
// THE GUARD. Every refusal found must be listed in ALLOWED_REFUSALS below,
// template by template and drill by drill, with its reason. A new refusal
// fails this test; so does an allowlisted refusal that no longer happens,
// so the list cannot go stale and hide a later regression behind an entry
// nobody needs.

jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(async () => {
    throw new Error('the sweep plans only; nothing may open a transaction');
  }),
}));

jest.mock('./drillLibraryV3', () => ({
  getDrillWithDetail: jest.fn(),
  getOtherVersionAdoption: jest.fn(),
  listReferenceLifecycles: jest.fn(),
}));

jest.mock('./drillFloorValidations', () => ({
  listFloorValidations: jest.fn(async () => ({})),
}));

jest.mock('./progression', () => {
  const actual = jest.requireActual('./progression');
  return {
    ...actual,
    // Asked only for a drill the gym already runs; a fresh load runs none.
    assertNewAssignmentMeetsCueRule: jest.fn(async () => {
      throw new Error('the sweep models an empty gym: no step may resolve to an operational drill');
    }),
  };
});

import fs from 'node:fs';
import path from 'node:path';

import { isConditioningLabel, NO_CUE_READINESS_MESSAGE } from '../../lib/drillCueRule';

import { committedPath, datasetSpec } from './contentImport/specs';
import type { ParsedFile } from './contentImport/types';
import { parseFile } from './contentImport/validate';
import { parseBoolean } from './contentImport/values';
import { query, queryOne } from './db';
import { getDrillWithDetail, getOtherVersionAdoption, listReferenceLifecycles } from './drillLibraryV3';
import { planTemplateIssue, type WorkoutTemplateItemWithDrillHead } from './workoutTemplates';

const SEED_DATA = path.join(__dirname, '..', '..', '..', 'seed-data');
const ORG = '{{PPBF_ORG_ID}}';

function committedFile(dataset: 'drill-library' | 'workout-templates', file: string): ParsedFile {
  const spec = datasetSpec(dataset).files.find((candidate) => candidate.file === file);
  if (!spec) throw new Error(`no spec for ${file}`);
  const relative = committedPath(spec);
  const { file: parsed, findings } = parseFile(relative, spec, fs.readFileSync(path.join(SEED_DATA, relative), 'utf8'));
  if (findings.length > 0) throw new Error(`${relative} did not parse: ${findings[0].message}`);
  return parsed;
}

function groupBy(file: ParsedFile, column: string): Map<string, Record<string, string>[]> {
  const out = new Map<string, Record<string, string>[]>();
  for (const row of file.rows) {
    const key = row.values[column];
    out.set(key, [...(out.get(key) ?? []), { ...row.values }]);
  }
  return out;
}

const drillRows = committedFile('drill-library', 'seed_drill_library.csv');
const scaleByDrill = groupBy(committedFile('drill-library', 'seed_drill_scale_levels.csv'), 'drill_id');
const stopByDrill = groupBy(committedFile('drill-library', 'seed_drill_stop_rules.csv'), 'drill_id');
const cuesByDrill = groupBy(committedFile('drill-library', 'seed_drill_cues.csv'), 'drill_id');
const templateRows = committedFile('workout-templates', 'seed_workout_templates.csv');
const itemsByTemplate = groupBy(committedFile('workout-templates', 'seed_workout_template_items.csv'), 'template_id');

/**
 * A drill as the fake getDrillWithDetail returns it: the committed row's text
 * columns (every column the readiness check reads among them), plus what the
 * loader decides and the drill's child rows.
 */
type LibraryDrill = Record<string, unknown> & {
  drill_id: string;
  discipline: string;
  cues: Record<string, string>[];
};

/** The library a fresh load leaves: lineage key -> the drill as getDrillWithDetail returns it. */
const library = new Map<string, LibraryDrill>(
  drillRows.rows.map(({ values }): [string, LibraryDrill] => [
    values.drill_id,
    {
      ...values,
      drill_id: values.drill_id,
      discipline: values.discipline,
      organization_id: ORG,
      version: 1,
      superseded_at: null,
      active: true,
      scale_levels: (scaleByDrill.get(values.drill_id) ?? []).map((level) => ({
        ...level,
        is_starting_point: parseBoolean(level.is_starting_point) === true,
      })),
      stop_rules: stopByDrill.get(values.drill_id) ?? [],
      universal_stop_rules: [],
      cues: cuesByDrill.get(values.drill_id) ?? [],
      secondary_skills: [],
    },
  ]),
);

beforeAll(() => {
  (query as jest.Mock).mockResolvedValue([]);
  (queryOne as jest.Mock).mockResolvedValue(null);
  (getOtherVersionAdoption as jest.Mock).mockResolvedValue(null);
  (getDrillWithDetail as jest.Mock).mockImplementation(async (_org: string, id: string) => library.get(id) ?? null);
  (listReferenceLifecycles as jest.Mock).mockImplementation(async (_org: string, ids: string[]) =>
    Object.fromEntries(ids.filter((id) => library.has(id)).map((id) => [id, { state: 'available', operational_drill_id: null }])));
});

interface Refusal {
  template_id: string;
  template: string;
  /** The refusing drill's lineage key, or `typed:<ordinal>` for a typed step. */
  key: string;
  name: string;
  steps: number[];
  reason: string;
  /** Whether every step of the template is typed (the coach-run reading, OD-2026-11-15-001). */
  all_typed: boolean;
}

type CommittedItem = Record<string, string>;

async function sweep(
  editItems: (templateId: string, items: CommittedItem[]) => CommittedItem[] = (_id, items) => items,
): Promise<{ checked: number; refusals: Refusal[] }> {
  const refusals: Refusal[] = [];
  let planned = 0;
  // Every template a fresh load leaves current: the loader writes active = true
  // for a new template (specs/templates.ts systemColumn('active', 'true')).
  for (const { values: template } of templateRows.rows) {
    const items = editItems(template.template_id, itemsByTemplate.get(template.template_id) ?? []).map((item) => ({
      ...item,
      ordinal: Number(item.ordinal),
      drill_id: item.drill_id || null,
      free_text_drill: item.free_text_drill || null,
      // Every committed drill is its lineage's first and only version, so the
      // head a step names is its own drill (asserted below).
      head_drill_id: item.drill_id || null,
      head_drill_name: null,
      drill_name: null,
      uses_older_drill_version: false,
    })) as unknown as WorkoutTemplateItemWithDrillHead[];
    const allTyped = items.length > 0 && items.every((item) => item.drill_id === null);
    const plan = await planTemplateIssue(ORG, items);
    planned += 1;
    for (const refused of plan.refused) {
      refusals.push({
        template_id: template.template_id,
        template: template.name,
        key: refused.drill_id ?? `typed:${refused.steps.join(',')}`,
        name: refused.name,
        steps: refused.steps,
        reason: refused.reason,
        all_typed: allTyped,
      });
    }
  }
  return { checked: planned, refusals };
}

// ---------------------------------------------------------------------------
// THE ALLOWLIST: every refusal a fresh load of the committed data gives today
// (lane RS sweep, measured on main 0752bb485908d259880925521f1a8672a75abe4f).
// Each group says why it is allowed. Nothing outside these lists may refuse,
// and every entry must still refuse.
// ---------------------------------------------------------------------------

/**
 * Every step typed text, so every step is refused (TYPED_STEP_REASON). Class
 * plans reads such a template as "Coach-run day: nothing to issue"
 * (OD-2026-11-15-001, ruling and reach); coaches run it from the plan. Template
 * id -> its typed steps (ordinals).
 */
const COACH_RUN: Record<string, number[]> = {
  wtp_000d2b85b29bbb: [1], // Phase 1 — Foundation / Novice — Scenario B Saturday
  wtp_0053dde5c924db: [1, 2, 3, 4, 5, 6, 7], // The Cool-Down — Standard Protocol
  wtp_010bb6fbf7c731: [1, 2, 3, 4, 5, 6], // The First 90 Days — A Concrete Start — Weeks 1–4 Thursday
  wtp_040289603033b6: [1, 2, 3, 4, 5], // Phase 1 — Foundation / Novice — Sparring session, 75 min (Phase 1, Sta
  wtp_060d401d23d474: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Tuesday
  wtp_06679961df65bb: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Friday
  wtp_080c41583b3757: [1, 2, 3, 4, 5, 6, 7], // Phase 2 — Competitive Amateur — Boxing skill session, 90 min (Phase 2–
  wtp_08589f20aec776: [1], // Phase 1 — Foundation / Novice — Scenario A Saturday
  wtp_08e72f7394aefe: [1], // The First 90 Days — A Concrete Start — Weeks 1–4 Tuesday
  wtp_0b2bb48d17e3be: [1, 2, 3, 4, 5], // Phase 3 — Advanced — Strength session — Phase 3 maintenance, 55 min
  wtp_10c6082f9d5089: [1, 2, 3], // Phase 3 — Advanced — Peak-specific week Wednesday
  wtp_151338565aea69: [1, 2, 3, 4, 5], // Youth Boxing Curriculum System — Class Structure
  wtp_15fd46693aae7e: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Saturday
  wtp_1696a57348cd45: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], // Advanced Non-Contact Trial Session (60 Minutes)
  wtp_16acacbeaa1eeb: [1, 2, 3, 4, 5, 6, 7, 8, 9], // Advanced Contact Sparring Simulation
  wtp_1745f8a78ac098: [1], // The First 90 Days — A Concrete Start — Weeks 1–4 Saturday
  wtp_1881d8b08576e5: [1, 2], // Phase 3 — Advanced — Peak-specific week Sunday
  wtp_1e77dabdfa54f8: [1], // Phase 1 — Foundation / Novice — Scenario A Wednesday
  wtp_23849b29f8592f: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Sunday
  wtp_25a003f73a472c: [1, 2, 3, 4], // Phase 3 — Advanced — Competition-simulation sparring session, 100 min
  wtp_2759a2e4865091: [1, 2, 3], // Phase 3 — Advanced — Peak-specific week Monday
  wtp_305c9d8653ae3c: [1], // Phase 1 — Foundation / Novice — Scenario A Friday
  wtp_363e43d4f3f870: [1, 2, 3, 4, 5, 6], // Phase 1 — Foundation / Novice — Strength session, 70 minutes (months 3
  wtp_3ba3110f2428d2: [1, 2, 3, 4, 5, 6], // Template D - Feint and Read Mitts
  wtp_43010f10a6b0b3: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Thursday
  wtp_4346e280d811e3: [1, 2, 3, 4, 5, 6, 7], // Strength session B — upper explosive + power, 70 min
  wtp_485b1e28f6cf9a: [1], // Phase 1 — Foundation / Novice — Scenario C Sunday
  wtp_4b192f174699bc: [1, 2, 3, 4, 5], // VERTICAL LINE & HOOK PLANE AWARENESS SESSION
  wtp_4d509fa48087ab: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Saturda
  wtp_4d5eb0ed94d617: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Friday
  wtp_52f7e4342df818: [1, 2], // Block Templates — Copy and Adapt — Buffering block Thursday
  wtp_5303f3ce867b0c: [1, 2], // Phase 1 — Foundation / Novice — Scenario B Thursday
  wtp_53b2fb2632b55b: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Monday
  wtp_588adc80b308df: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Monday
  wtp_58f38298573058: [1], // Phase 1 — Foundation / Novice — Scenario A Thursday
  wtp_5df3589b9085d2: [1], // The First 90 Days — A Concrete Start — Weeks 1–4 Sunday
  wtp_650f015252583e: [1], // Phase 1 — Foundation / Novice — Scenario A Monday
  wtp_6664906527b540: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Tuesday
  wtp_66bc4949709320: [1], // Phase 1 — Foundation / Novice — Scenario A Tuesday
  wtp_66e85b0fc287ea: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Tuesday
  wtp_6bd117a9ae1263: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Thursday
  wtp_6bdab8e5169726: [1], // Phase 1 — Foundation / Novice — Scenario B Monday
  wtp_6de6cb7607bb2b: [1, 2, 3, 4], // Phase 1 — Foundation / Novice — Conditioning session, 45 minutes (HIIT
  wtp_7069f515b9b84e: [1, 2, 3, 4, 5, 6], // Phase 2 — Competitive Amateur — Strength session — lower-body emphasis
  wtp_70dc2415bd2c93: [1, 2], // Phase 3 — Advanced — Peak-specific week Saturday
  wtp_73621edf20014a: [1], // Phase 1 — Foundation / Novice — Scenario B Sunday
  wtp_7db7ce1a5c11d8: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Sunday
  wtp_7e4b1fcacf2a9b: [1, 2, 3], // Phase 3 — Advanced — Peak-specific week Tuesday
  wtp_840621865a088d: [1, 2, 3, 4, 5, 6, 7, 8], // FULL ACTIVE RECOVERY BOXING SESSION
  wtp_84cb2cf887a94a: [1], // Phase 1 — Foundation / Novice — Scenario A Sunday
  wtp_996aa8be552ed0: [1], // Phase 1 — Foundation / Novice — Scenario B Wednesday
  wtp_9cd67911f6c526: [1, 2], // Block Templates — Copy and Adapt — Buffering block Sunday
  wtp_9e9710b7ff5736: [1, 2, 3, 4, 5, 6, 7], // The Warm-Up — Standard Protocol
  wtp_a2d9f97418ec52: [1, 2, 3, 4, 5, 6], // Tactical session, 90 min (archetype focus)
  wtp_a6af9b142437ca: [1, 2], // Block Templates — Copy and Adapt — Buffering block Tuesday
  wtp_a7b1f9ac59530e: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Friday
  wtp_a97e05c665c596: [1, 2, 3, 4, 5, 6], // Template C - Pressure Control Mitts
  wtp_aa6e79d35d0ec7: [1], // The First 90 Days — A Concrete Start — Weeks 1–4 Wednesday
  wtp_b314d9a0582d20: [1, 2, 3, 4, 5, 6, 7], // The permanent circuit — every warm-up, forever, ~10 min
  wtp_b368e0355b3bbb: [1], // Block Templates — Copy and Adapt — Buffering block Saturday
  wtp_b52e6a56afea4b: [1, 2], // Phase 4 — Elite / Champion-tier — Mid-camp week Wednesday
  wtp_b604cd74564a8c: [1, 2], // Phase 1 — Foundation / Novice — Scenario B Tuesday
  wtp_bdb23cdf150b86: [1, 2], // Block Templates — Copy and Adapt — Buffering block Monday
  wtp_c0c9286e8bc870: [1, 2, 3, 4, 5, 6, 7, 8, 9], // Eight-week camp — Competition-day warm-up, 35–40 min
  wtp_c49ef523671d1d: [1, 2, 3, 4, 5, 6], // Template B - Defense-to-Counter Mitts
  wtp_c4ce7036fc104d: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Wednesday
  wtp_c90799996823b7: [1], // The First 90 Days — A Concrete Start — Weeks 1–4 Friday
  wtp_ca384cb3b5581a: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Wednesd
  wtp_cfa42f86002f98: [1, 2, 3], // Phase 3 — Advanced — Peak-specific week Thursday
  wtp_d2f730ec22b7fb: [1, 2, 3, 4, 5, 6], // Template A - Mechanics Mitts
  wtp_d359ba85193b3b: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Saturday
  wtp_d6eb362e8eca13: [1, 2], // Block Templates — Copy and Adapt — Buffering block Wednesday
  wtp_da83ce464ffa96: [1, 2, 3], // Phase 2 — Competitive Amateur — Buffering conditioning session, 50 min
  wtp_e2302f73a5d19a: [1, 2, 3, 4, 5, 6], // Template E - Fight-Plan Mitts
  wtp_e33a4f20bca215: [1, 2, 3, 4, 5, 6], // The First 90 Days — A Concrete Start — Weeks 1–4 Monday
  wtp_e3aa9cda9f1675: [1, 2], // Phase 1 — Foundation / Novice — Scenario C Monday
  wtp_f2488df4fa331a: [1, 2, 3, 4, 5, 6, 7], // Session structure for skill development
  wtp_f3d74ccca9cc85: [1, 2, 3], // 8-Week Non-Contact Boxing Pilot Program — Friday Protocol
  wtp_f448464103ec0a: [1, 2, 3], // Phase 3 — Advanced — Peak-specific week Friday
  wtp_f581f36db0076e: [1, 2], // Block Templates — Copy and Adapt — Buffering block Friday
  wtp_f76a229c0ca26a: [1], // Phase 1 — Foundation / Novice — Scenario B Friday
  wtp_fe550473f8a412: [1], // Block Templates — Copy and Adapt — Anatomical adaptation block Thursda
};

/**
 * Typed steps beside library drills. The typed steps refuse the whole issue,
 * and OD-2026-11-15-001's reach says such a template "is not covered and still
 * reads 'Not ready'". Jason's card OW26-05 ("Mixed templates"): "B: Turn typed
 * lines into library drills" (OD-2026-11-19-030). The typed steps are to become library drills
 * (in PPBF words, AI-draft labelled) after the pilot, in a separate lane; until
 * then they are refused at issue. The app diverges from the frozen Backbone
 * here (D-OQ44 keeps DOC-151's lines as free text). An entry leaves this list
 * when its template's typed steps are drills. Template id -> its typed steps
 * (ordinals).
 */
const TYPED_IN_MIXED: Record<string, number[]> = {
  wtp_bc964fe230d8f3: [1, 2, 6, 9], // Phase 2 — Competitive Amateur — Archetype tactical session — vs. press
};

/**
 * Library drills that refuse the issue, each waiting on coach text: no
 * committed source holds a cue for it, so none is filled in. The cue rule is
 * OD-2026-10-06-026 ruling 2 (the Overwatch note recorded in OD-2026-11-19-005 keeps it). Template id -> the
 * refusing drills' lineage keys. An entry leaves this list when its drill can
 * be adopted. Lane RS (#2008) gave sourced cues to Wrap Under Supervision,
 * Seated Combination Work and Technique-Only Fitness Session, which took four
 * templates off this list.
 */
const DRILL_REFUSALS: Record<string, string[]> = {
  // Technique Hold Under Volume: needs coach text (OD-2026-10-11-009 item 3:
  // its cue is drafted for a coach to approve, not put in the app).
  wtp_e3c1f50475379b: ["drl_b755caac79e37e"], // Intermediate Combinations — Random Practice (step 6)
};

function bySignature(refusals: readonly Refusal[]) {
  const out: Record<string, { typed: number[]; drills: string[] }> = {};
  for (const refusal of refusals) {
    const entry = (out[refusal.template_id] ??= { typed: [], drills: [] });
    if (refusal.key.startsWith('typed:')) entry.typed.push(...refusal.steps);
    else entry.drills.push(refusal.key);
  }
  for (const entry of Object.values(out)) {
    entry.typed.sort((a, b) => a - b);
    entry.drills.sort();
  }
  return out;
}

function expectedSignature() {
  const out: Record<string, { typed: number[]; drills: string[] }> = {};
  const add = (id: string) => (out[id] ??= { typed: [], drills: [] });
  for (const [id, steps] of Object.entries({ ...COACH_RUN, ...TYPED_IN_MIXED })) add(id).typed.push(...steps);
  for (const [id, drills] of Object.entries(DRILL_REFUSALS)) add(id).drills.push(...drills);
  for (const entry of Object.values(out)) {
    entry.typed.sort((a, b) => a - b);
    entry.drills.sort();
  }
  return out;
}

describe('committed workout templates against the issue plan (fresh load)', () => {
  it('holds no template without steps, which the issue refuses before its plan (WORKOUT_TEMPLATE_EMPTY)', () => {
    // workoutTemplates.ts issueWorkoutTemplate: "This workout template has no steps to issue." The plan this
    // suite runs never sees that refusal, so the committed data is held to having none instead.
    const empty = templateRows.rows.filter(({ values }) => (itemsByTemplate.get(values.template_id) ?? []).length === 0);
    expect(empty.map(({ values }) => values.template_id)).toEqual([]);
  });

  it('reads committed drills that are each the first version of their own lineage', () => {
    // The head rule (a step names its lineage's newest version) needs no
    // resolving while this holds; a committed second version would need it.
    for (const { values } of drillRows.rows) {
      expect({ id: values.drill_id, lineage: values.lineage_id, superseded: values.superseded_at })
        .toEqual({ id: values.drill_id, lineage: values.drill_id, superseded: '' });
    }
  });

  it('refuses exactly the allowlisted steps and drills, and nothing else', async () => {
    const result = await sweep();
    const out = process.env.SWEEP_REPORT;
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
    expect(result.checked).toBe(templateRows.rows.length);
    expect(bySignature(result.refusals)).toEqual(expectedSignature());
  });

  it('allowlists as coach-run only templates whose every step is typed, and as mixed only templates that are not', async () => {
    const { refusals } = await sweep();
    const allTyped = new Map(refusals.map((refusal) => [refusal.template_id, refusal.all_typed]));
    for (const id of Object.keys(COACH_RUN)) expect({ id, allTyped: allTyped.get(id) }).toEqual({ id, allTyped: true });
    for (const id of Object.keys(TYPED_IN_MIXED)) expect({ id, allTyped: allTyped.get(id) }).toEqual({ id, allTyped: false });
  });

  it('refuses every allowlisted drill for the cue rule alone', async () => {
    const { refusals } = await sweep();
    for (const refusal of refusals.filter((candidate) => !candidate.key.startsWith('typed:'))) {
      expect({ drill: refusal.key, reason: refusal.reason }).toEqual({ drill: refusal.key, reason: NO_CUE_READINESS_MESSAGE });
    }
  });

  // NEGATIVE CONTROLS: the sweep has to be able to see a refusal in a template
  // that issues today, or a green run above would prove nothing.
  describe('sees a new refusal in a template that issues today', () => {
    const issuable = () => {
      const refused = new Set(Object.keys(expectedSignature()));
      const template = templateRows.rows.find(({ values }) => !refused.has(values.template_id)
        && (itemsByTemplate.get(values.template_id) ?? []).some((item) => {
          const drill = item.drill_id ? library.get(item.drill_id) : undefined;
          return drill !== undefined && !isConditioningLabel(drill.discipline);
        }));
      if (!template) throw new Error('no issuable template with a technique drill to break');
      return template.values.template_id;
    };

    it('a technique drill that loses its cues', async () => {
      const templateId = issuable();
      const item = (itemsByTemplate.get(templateId) ?? []).find((candidate) =>
        candidate.drill_id && !isConditioningLabel(library.get(candidate.drill_id)?.discipline));
      const drill = library.get(item?.drill_id ?? '');
      if (!drill) throw new Error('unreachable: issuable() picked a template with a technique drill');
      const cues = drill.cues;
      drill.cues = [];
      try {
        const { refusals } = await sweep();
        expect(refusals).toContainEqual(expect.objectContaining({
          template_id: templateId,
          key: drill.drill_id,
          reason: NO_CUE_READINESS_MESSAGE,
        }));
      } finally {
        drill.cues = cues;
      }
    });

    it('a step that becomes typed text', async () => {
      const templateId = issuable();
      const { refusals } = await sweep((id, items) => (id === templateId
        ? items.map((item, index) => (index === 0 ? { ...item, drill_id: '', free_text_drill: 'Typed by the sweep' } : item))
        : items));
      expect(refusals).toContainEqual(expect.objectContaining({ template_id: templateId, key: expect.stringMatching(/^typed:/) }));
    });
  });
});
