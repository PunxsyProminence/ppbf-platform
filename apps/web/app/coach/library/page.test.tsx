/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, getDefaultNormalizer, render, screen, waitFor, within } from '@testing-library/react';

import LibraryPage from './page';
import type { ClubRole } from '@/components/roleRoutes';

// Library (lane YR-c): library tracks, read-only. What these pin: the coach and
// gym-admin gate; the list read is ?library=1; a track opens through ?track=;
// blocks render by type; the USA Boxing line shows directly under the sheet's
// Thursday "REST / WEIGH-IN" line on both DOC-154 sheets with the sheet text
// unchanged (OD-2026-11-16-004); backbone differences, differences and owner
// passages are plain information, never an alert or an input
// (OD-2026-11-10-001 RULES s1); a beside line that does not match is still shown.
// Sheet text below is DOC-154's own; every other string is made up.

const capturedRoles: ClubRole[][] = [];

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: ClubRole[]; readonly children: ReactNode }) => {
    capturedRoles.push(allowedRoles);
    return children;
  },
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

const BOUT = 'Bout Date: ____________    Rounds: Youth (2 x 2 min)';
const THURSDAY = 'THURSDAY – REST / WEIGH-IN (Walk, Stretch, Rehydrate, Early sleep)';
const THU_2 = 'REST / WEIGH-IN: Walk + stretch | Rehydrate smart | Early sleep';
const USAB_LINE = "'Day-before' conflicts with USA Boxing 2026 Rule 11.1(2) (weigh in on the day they box) on the USA Boxing route; 11.2 events use the same 'Daily weigh-in' (INFERRED same day).";
const USAB_CAVEAT = 'The card for OW25-23 says the research session read the USA Boxing rule only in search-result excerpts, not the full 2026 rule book.';
const besideLine = (group_section: string, block_index: number, sheet_text: string) => ({
  group_section, block_index, sheet_text, line_key: 'USAB-R11', line_text: USAB_LINE,
  sources: ['EXT-USAB-RB2026'], caveat: USAB_CAVEAT, ruling: 'OD-2026-11-16-004',
});
const BACKBONE = { card: 'CD-Q07', text: BOUT, backbone: 'Made-up backbone rounds line.', label: 'Made-up label: both texts shown.', reading: 'Made-up reading.', status: 'OBSERVED' };

const FIGHT_WEEK_SUMMARY = { track_id: 'trk_98f1b755dce913', name: 'FIGHT WEEK CHECKLIST – FIRST COMPETITION (USA BOXING)', lane: 'standard', age_band: 'youth Y2 to Y5', part_heading: null, chapter_heading: null, subtitle: null, group_count: 2 };
const MANUAL_SUMMARY = { track_id: 'trk_00000000000a01', name: 'Made-up manual', lane: 'standard', age_band: 'any', part_heading: 'PART 9 — MADE UP', chapter_heading: '1. Made-up chapter', subtitle: null, group_count: 1 };

const FIGHT_WEEK = {
  ...FIGHT_WEEK_SUMMARY, track: null, duration_weeks: null, block_count: 0, day_count: 0, sources: ['DOC-154'], weeks: [],
  details: {
    groups: [
      {
        order: 1, section: 'DOC-154 sheet 1', heading: 'FIGHT WEEK CHECKLIST – FIRST COMPETITION (USA BOXING)', source: 'DOC-154 (sheet 1)',
        blocks: [
          { type: 'text', text: 'Athlete: ____________    Age: ______    Weight: ______' },
          { type: 'text', text: BOUT },
          { type: 'checkbox', text: 'MONDAY – Sharpness (Rope 3x2, Shadow 4x2, Mitts 4x2, Defense 2x2, Visualize)' },
          { type: 'checkbox', text: 'TUESDAY – Speed & IQ (Shadow 3x2, Reaction drills, Footwork 3x2, Mitts 3x2)' },
          { type: 'checkbox', text: 'WEDNESDAY – Touch & Feel (Light shadow 3x2, Double-end/mitts 3x2, Stretch)' },
          { type: 'checkbox', text: THURSDAY },
          { type: 'checkbox', text: 'FRIDAY – FIGHT DAY Warm-Up (Rope 2x2, Shadow 2x2, Pads 2x1)' },
          { type: 'subheading', text: 'FIGHT CUES CHECKLIST' },
          { type: 'checkbox', text: 'Jab first' },
        ],
        backbone_differences: [BACKBONE],
      },
      {
        order: 2, section: 'DOC-154 sheet 2', heading: 'FIGHT WEEK TRAINING SHEET – FIRST COMPETITION (USA BOXING)', source: 'DOC-154 (sheet 2)',
        blocks: [
          { type: 'text', text: 'Athlete: ____________    Age: ______    Weight: ______' },
          { type: 'text', text: BOUT },
          { type: 'text', text: 'WEEK GOAL: Stay sharp, relaxed, and confident. No hard conditioning. No new skills.' },
          { type: 'subheading', text: 'MON' },
          { type: 'text', text: 'Sharpness: Rope 3x2 | Shadow 4x2 | Mitts 4x2 | Defense 2x2 | Visualize' },
          { type: 'subheading', text: 'TUE' },
          { type: 'text', text: 'Speed & IQ: Shadow 3x2 | Reaction drills | Footwork 3x2 | Mitts 3x2' },
          { type: 'subheading', text: 'WED' },
          { type: 'text', text: 'Touch & Feel: Light shadow 3x2 | Double-end or mitts 3x2 | Stretch' },
          { type: 'subheading', text: 'THU' },
          { type: 'text', text: THU_2 },
          { type: 'subheading', text: 'FRI' },
        ],
        backbone_differences: [BACKBONE],
        differences: [{ card: 'CD-X01', label: 'Made-up group label', reading: 'Made-up group reading', text_1: 'Made-up first text', text_2: 'Made-up second text' }],
      },
    ],
    beside_lines: [besideLine('DOC-154 sheet 1', 5, THURSDAY), besideLine('DOC-154 sheet 2', 10, THU_2)],
    differences: [{ card: 'CD-X02', label: 'Made-up track label', reading: 'Made-up track reading', text_1: 'Made-up text one', text_2: 'Made-up text two' }],
    owner_passages: [
      {
        doc: 'DOC-900', doc_title: 'Made-up manual', source_manual: 'Made-up source manual', section: 'Made-up section',
        purpose: 'Made-up purpose.', standards: ['Made-up standard one.', 'Made-up standard two.'], row: { Row_Key: 'Made-up row value' },
        beside: ['groups'], read_for: 'Made-up read-for line', reading_note: 'Made-up reading note', group: 'DOC-154 sheet 1',
        difference: { label: 'Made-up passage difference label', reading: 'Made-up passage difference reading' },
      },
      { doc: 'DOC-901', doc_title: 'Second made-up manual', sheet: 'Made-up sheet', row_id: 'ROW-1', lines: ['Made-up stray line'], beside: [], read_for: 'x', difference: null },
    ],
    session_refs: [{ template_id: 'wtp_0000000000000a', name: 'Made-up session ref' }],
    field_provenance: 'PPBF owner-authored',
  },
};

function mockReads(track: unknown, tracks: unknown[] = [FIGHT_WEEK_SUMMARY, MANUAL_SUMMARY]) {
  global.fetch = jest.fn(async (url: string) => (url.includes('?track=') ? json({ track }) : json({ tracks }))) as unknown as typeof fetch;
}

async function openFirst(name: string) {
  render(<LibraryPage />);
  const card = (await screen.findByText(name)).closest('article')!;
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Open' }));
}

beforeEach(() => {
  capturedRoles.length = 0;
});

describe('Library page', () => {
  it('sits behind the coach and gym-admin gate, reads ?library=1, and lists names, headings and age band', async () => {
    mockReads(FIGHT_WEEK);
    render(<LibraryPage />);
    expect(await screen.findByText('Made-up manual')).toBeInTheDocument();
    expect(capturedRoles.at(-1)).toEqual(['coach', 'admin']);
    expect((global.fetch as jest.Mock).mock.calls.map(([url]) => url)).toEqual(['/api/pilot/training-tracks?library=1']);
    expect(screen.getByText('PART 9 — MADE UP · 1. Made-up chapter')).toBeInTheDocument();
    expect(screen.getByText('youth Y2 to Y5')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Class plans' })).toHaveAttribute('href', '/coach/class-plans');
  });

  it('shows the USA Boxing line directly under the Thursday REST / WEIGH-IN line of both sheets, the sheet text unchanged', async () => {
    mockReads(FIGHT_WEEK);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    expect((global.fetch as jest.Mock).mock.calls.at(-1)![0]).toBe('/api/pilot/training-tracks?track=trk_98f1b755dce913');

    const thursday = await screen.findByText(THURSDAY);
    expect(thursday.textContent).toBe(THURSDAY);
    const item = thursday.closest('li')!;
    expect(within(item).getByText(USAB_LINE)).toBeInTheDocument();
    expect(within(item).getByText('Source: USAB-R11 (EXT-USAB-RB2026)')).toBeInTheDocument();
    expect(within(item).getByText(USAB_CAVEAT)).toBeInTheDocument();
    expect(within(item).getByText('Shown beside the sheet; nothing on the sheet is edited (OD-2026-11-16-004).')).toBeInTheDocument();

    const thu2 = screen.getByText(THU_2);
    expect(thu2.textContent).toBe(THU_2);
    expect(within(thu2.parentElement!).getByText(USAB_LINE)).toBeInTheDocument();
    // Once per sheet, nowhere else, and never at a group's end.
    expect(screen.getAllByText(USAB_LINE)).toHaveLength(2);
    expect(screen.queryByText('Shown beside this sheet')).toBeNull();
    // Friday's line carries nothing.
    expect(within(screen.getByText(/^FRIDAY/).closest('li')!).queryByText(USAB_LINE)).toBeNull();
  });

  it('renders checkboxes as a glyph, not an input, and nothing on the track is an alert', async () => {
    mockReads(FIGHT_WEEK);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    const jab = await screen.findByText('Jab first');
    expect(jab.closest('li')!.textContent).toBe('☐ Jab first');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'FIGHT CUES CHECKLIST' })).toBeInTheDocument();
    // The first five checkboxes and then Jab first: two lists, split by the subheading.
    expect(thursdayList().querySelectorAll('li')).toHaveLength(5);
  });

  it('shows the CD-Q07 backbone difference under the Bout Date line of each sheet, and differences as information', async () => {
    mockReads(FIGHT_WEEK);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    await screen.findByText(THURSDAY);
    const notes = screen.getAllByText('Backbone (CD-Q07): Made-up backbone rounds line.');
    expect(notes).toHaveLength(2);
    // The sheet's own spacing, kept: matched without collapsing whitespace.
    const bouts = screen.getAllByText(BOUT, { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) });
    expect(bouts).toHaveLength(2);
    for (const bout of bouts) {
      expect(within(bout.parentElement!).getByText('Backbone (CD-Q07): Made-up backbone rounds line.')).toBeInTheDocument();
    }
    expect(screen.getAllByText('Made-up label: both texts shown.')).toHaveLength(2);
    for (const text of ['Difference (CD-X01)', 'Made-up group label', 'Made-up group reading', '"Made-up first text"', '"Made-up second text"',
      'Difference (CD-X02)', 'Made-up track label', 'Made-up track reading', '"Made-up text one"', '"Made-up text two"']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('shows owner passages with their group, the rest at the end, without the reading notes; and the other keys under About this track', async () => {
    mockReads(FIGHT_WEEK);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    await screen.findByText(THURSDAY);
    expect(screen.getAllByText('Owner passages (1)')).toHaveLength(2);
    expect(screen.getByText('DOC-900 Made-up manual — Made-up source manual — Made-up section')).toBeInTheDocument();
    expect(screen.getByText('Made-up purpose.')).toBeInTheDocument();
    expect(screen.getByText('Made-up standard two.')).toBeInTheDocument();
    expect(screen.getByText('Made-up row value')).toBeInTheDocument();
    expect(screen.getByText('Made-up passage difference label')).toBeInTheDocument();
    expect(screen.getByText('Made-up passage difference reading')).toBeInTheDocument();
    expect(screen.getByText('DOC-901 Second made-up manual — Made-up sheet — ROW-1')).toBeInTheDocument();
    expect(screen.getByText('Made-up stray line')).toBeInTheDocument();
    for (const hidden of ['Made-up read-for line', 'Made-up reading note', 'Made-up session ref']) {
      expect(screen.queryByText(new RegExp(hidden))).toBeNull();
    }
    expect(screen.getByRole('heading', { name: 'About this track' })).toBeInTheDocument();
    expect(screen.getByText('Field provenance')).toBeInTheDocument();
    expect(screen.getByText('PPBF owner-authored')).toBeInTheDocument();
  });

  it('never drops a beside line whose text does not match: it shows at the end of its group, or of the track', async () => {
    const track = {
      ...FIGHT_WEEK,
      details: {
        groups: [{ section: 'S1', heading: 'Made-up sheet', blocks: [{ type: 'text', text: 'Made-up line A' }, { type: 'text', text: 'Made-up line B' }] }],
        beside_lines: [
          { ...besideLine('S1', 1, 'Made-up line changed'), line_text: 'Made-up beside, moved' },
          { ...besideLine('S9', 0, 'Made-up line A'), line_text: 'Made-up beside, no group' },
        ],
      },
    };
    mockReads(track);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    const lineB = await screen.findByText('Made-up line B');
    expect(within(lineB.parentElement!).queryByText('Made-up beside, moved')).toBeNull();
    expect(within(screen.getByText('Shown beside this sheet').parentElement!).getByText('Made-up beside, moved')).toBeInTheDocument();
    expect(within(screen.getByText('Shown beside the sheets').parentElement!).getByText('Made-up beside, no group')).toBeInTheDocument();
  });

  it('renders tables, preformatted text, source files and bullets, and an unknown block type without crashing', async () => {
    const track = {
      ...FIGHT_WEEK,
      details: {
        part_heading: 'PART 9 — MADE UP', chapter_heading: '1. Made-up chapter', publisher_line: 'Made-up publisher',
        groups: [{
          section: 'S1', heading: 'Made-up heading', source: 'Made-up source line',
          blocks: [
            { type: 'table', header: ['Rung', 'Format'], rows: [{ Rung: '1', Format: 'Made-up format' }, { Rung: '2' }] },
            { type: 'preformatted', lines: ['Made-up pre one', '  Made-up pre two'] },
            { type: 'source', file: 'made-up.pdf', sha256_16: 'abc' },
            { type: 'bullet', text: 'Made-up bullet one' },
            { type: 'bullet', text: 'Made-up bullet two' },
            { type: 'callout', text: 'Made-up unknown kind' },
            { type: 'mystery' },
            null,
            { type: 'bullet', text: 'Made-up bullet three' },
          ],
        }],
      },
    };
    mockReads(track);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Rung', 'Format']);
    expect(screen.getAllByRole('row')[2].querySelectorAll('td')[1].textContent).toBe('');
    expect(document.querySelector('pre')!.textContent).toBe('Made-up pre one\n  Made-up pre two');
    expect(screen.getByText('Source file: made-up.pdf')).toBeInTheDocument();
    const one = screen.getByText('Made-up bullet one').closest('ul')!;
    expect(within(one).getByText('Made-up bullet two')).toBeInTheDocument();
    expect(within(one).queryByText('Made-up bullet three')).toBeNull();
    expect(screen.getByText('Made-up unknown kind')).toBeInTheDocument();
    for (const text of ['PART 9 — MADE UP', '1. Made-up chapter', 'Made-up publisher', 'Made-up source line']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });

  it('shows a section intro, appendix heading, owner rules and the drills and sessions it names, as information', async () => {
    const track = {
      ...FIGHT_WEEK,
      details: {
        groups: [{
          section: 'S1', heading: 'Made-up heading', appendix_heading: 'Appendix Z \u2014 Made up', intro: { text: 'Made-up intro text.', storage: 'x' },
          blocks: [{ type: 'text', text: 'Made-up line' }],
          owner_rules: [{ rule: 'Made-up owner rule.', owner_text: 'Made-up owner words.', owner_source: 'DOC-900 (made up)', changed_by: 'Made-up change note' }],
          drill_refs: [{ name: 'Made-up drill', drill_id: 'drl_0000000000000a', subheading: 'Made-up group', coach_note: 'Made-up coach note' }],
          session_refs: [{ template_id: 'wtp_0000000000000b', name: 'Made-up session' }],
        }],
      },
    };
    mockReads(track);
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    expect(await screen.findByText('Made-up intro text.')).toBeInTheDocument();
    expect(screen.getByText('Appendix Z \u2014 Made up')).toBeInTheDocument();
    expect(screen.getByText('Made-up owner rule.')).toBeInTheDocument();
    expect(screen.getByText('"Made-up owner words." (DOC-900 (made up))')).toBeInTheDocument();
    expect(screen.getByText('Made-up group: Made-up drill (Made-up coach note)')).toBeInTheDocument();
    expect(screen.getByText('Made-up session')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a failed load is a failure, not an empty library; and says empty when empty', async () => {
    global.fetch = jest.fn(async () => json({}, false)) as unknown as typeof fetch;
    const { unmount } = render(<LibraryPage />);
    expect(await screen.findByText(/failure to load, not an empty library/)).toBeInTheDocument();
    unmount();
    global.fetch = jest.fn(async () => json({ tracks: [] })) as unknown as typeof fetch;
    render(<LibraryPage />);
    await waitFor(() => expect(screen.getByText(/No library tracks are loaded/)).toBeInTheDocument());
  });

  // P6 (OD-2026-11-17-009, OW25-34 A; Overwatch DFX Q2: the generic label).
  it('labels each beside line, says "not set" for a detail with no value, and gives the passages a 55px tap row', async () => {
    mockReads({ ...FIGHT_WEEK, details: { ...FIGHT_WEEK.details, made_up_empty_detail: null } });
    await openFirst(FIGHT_WEEK_SUMMARY.name);
    const thursday = await screen.findByText(THURSDAY);
    const item = thursday.closest('li')!;
    expect(within(item).getByText('Shown beside the sheet')).toBeInTheDocument();
    expect(within(item).getByText('Shown beside the sheet').className).toBe('t-label');
    expect(screen.getByText('not set')).toBeInTheDocument();
    expect(screen.queryByText('null')).toBeNull();
    expect(document.querySelectorAll('summary').length).toBeGreaterThan(0);
    for (const summary of document.querySelectorAll('summary')) {
      expect(summary.className).toContain('min-h-[var(--tap)]');
    }
  });

  it('sets both error lines at the kiosk text size (P6)', () => {
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const path = jest.requireActual('node:path') as typeof import('node:path');
    const source = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    const errorLines = source.split('\n').filter((line) => /\{(loadError|detailError)\}|font-semibold text-\[color:var\(--bone-100\)\]/.test(line));
    expect(errorLines.length).toBeGreaterThanOrEqual(2);
    for (const line of errorLines) expect(line).not.toMatch(/--t-sm/);
  });

  it('uses no warning colour anywhere on the page', () => {
    // A source check on purpose: --locked means a medical stop and nothing else.
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const path = jest.requireActual('node:path') as typeof import('node:path');
    expect(fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8')).not.toMatch(/var\(--locked|--danger|--warn/);
  });
});

function thursdayList(): HTMLElement {
  return screen.getByText(THURSDAY).closest('ul') as HTMLElement;
}
