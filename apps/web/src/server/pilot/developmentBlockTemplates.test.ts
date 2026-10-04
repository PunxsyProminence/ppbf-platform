import { assertActorCanAccessAthlete } from './access';
import { queryOne } from './db';
import {
  DEVELOPMENT_BLOCK_TEMPLATE_IDS,
  DEVELOPMENT_BLOCK_TEMPLATES,
  listDevelopmentBlockTemplatesForAthlete,
  templatesFor,
} from './developmentBlockTemplates';

jest.mock('./access', () => ({ assertActorCanAccessAthlete: jest.fn() }));
jest.mock('./db', () => ({ queryOne: jest.fn() }));

const mockedGate = assertActorCanAccessAthlete as jest.MockedFunction<typeof assertActorCanAccessAthlete>;
const mockedQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

const actor = { organizationId: 'org-1', accountId: 'coach-1', role: 'coach' } as never;
const NOW = new Date('2026-10-04T12:00:00Z');

beforeEach(() => {
  mockedGate.mockReset();
  mockedQueryOne.mockReset();
});

describe('the five templates', () => {
  it('are exactly the five the owner named, once each', () => {
    expect(DEVELOPMENT_BLOCK_TEMPLATES.map((t) => t.id)).toEqual([...DEVELOPMENT_BLOCK_TEMPLATE_IDS]);
    expect(DEVELOPMENT_BLOCK_TEMPLATES.map((t) => t.name)).toEqual([
      'Aerobic base',
      'General strength',
      'Maximal strength',
      'Power',
      'Fight-specific conditioning',
    ]);
  });

  it.each(DEVELOPMENT_BLOCK_TEMPLATES.map((t) => [t.id, t]))(
    '%s labels its numbers [AI-H] in the text a coach saves',
    (_id, template) => {
      expect(template.title.trim()).not.toBe('');
      expect(template.emphasis).toContain('[AI-H]');
      // Every line carrying a number sits below the [AI-H] label.
      const lines = template.emphasis.split('\n');
      const labelAt = lines.findIndex((line) => line.includes('[AI-H]'));
      lines.forEach((line, index) => {
        if (/\d/.test(line)) expect(index).toBeGreaterThanOrEqual(labelAt);
      });
    },
  );

  it.each(DEVELOPMENT_BLOCK_TEMPLATES.map((t) => [t.id, t]))(
    '%s carries tagged evidence notes',
    (_id, template) => {
      expect(template.evidence.length).toBeGreaterThan(0);
      for (const note of template.evidence) {
        expect(['SR/MA', 'PS', 'AI-H']).toContain(note.tag);
        expect(note.text.trim()).not.toBe('');
      }
    },
  );

  it('every template notes the concurrent-training mitigations and model equivalence [SR/MA]', () => {
    for (const template of DEVELOPMENT_BLOCK_TEMPLATES) {
      const srma = template.evidence.filter((n) => n.tag === 'SR/MA').map((n) => n.text).join(' ');
      expect(srma).toMatch(/strength before endurance/);
      expect(srma).toMatch(/roughly equivalent/);
    }
  });
});

describe('templatesFor: adults by default, minors only on the coach opt-in', () => {
  it('adult: templates', () => {
    expect(templatesFor(true, false)).toEqual({
      athlete_is_adult: true,
      templates: DEVELOPMENT_BLOCK_TEMPLATES,
      withheld_reason: null,
    });
  });

  it('minor without opt-in: none, with the reason', () => {
    expect(templatesFor(false, false)).toEqual({
      athlete_is_adult: false,
      templates: [],
      withheld_reason: 'minor_or_no_date_of_birth',
    });
  });

  it('minor with opt-in: templates, still reported as not adult', () => {
    const result = templatesFor(false, true);
    expect(result.templates).toBe(DEVELOPMENT_BLOCK_TEMPLATES);
    expect(result.athlete_is_adult).toBe(false);
  });
});

describe('listDevelopmentBlockTemplatesForAthlete', () => {
  it('asks the athlete gate first, and reads nothing when it refuses', async () => {
    mockedGate.mockRejectedValue(new Error('Forbidden'));
    await expect(listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW })).rejects.toThrow('Forbidden');
    expect(mockedGate).toHaveBeenCalledWith(actor, 'ath-1');
    expect(mockedQueryOne).not.toHaveBeenCalled();
  });

  it('scopes the dob read to the actor organization', async () => {
    mockedQueryOne.mockResolvedValue({ dob: '1990-01-01' });
    await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(mockedQueryOne.mock.calls[0][1]).toEqual(['org-1', 'ath-1']);
  });

  it('adult (18 today): templates', async () => {
    mockedQueryOne.mockResolvedValue({ dob: '2008-10-04' });
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(result.athlete_is_adult).toBe(true);
    expect(result.templates).toHaveLength(5);
  });

  it('17, one day short of 18: withheld', async () => {
    mockedQueryOne.mockResolvedValue({ dob: '2008-10-05' });
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(result.templates).toEqual([]);
  });

  it('no date of birth on file counts as a minor', async () => {
    mockedQueryOne.mockResolvedValue({ dob: null });
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(result).toMatchObject({ athlete_is_adult: false, templates: [] });
  });

  it('no athlete row counts as not adult', async () => {
    mockedQueryOne.mockResolvedValue(null);
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(result.templates).toEqual([]);
  });

  it('minor with the opt-in: templates', async () => {
    mockedQueryOne.mockResolvedValue({ dob: '2012-03-14' });
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW, minorOptIn: true });
    expect(result.templates).toHaveLength(5);
    expect(result.athlete_is_adult).toBe(false);
  });

  it('never returns the date of birth', async () => {
    mockedQueryOne.mockResolvedValue({ dob: '1990-01-01' });
    const result = await listDevelopmentBlockTemplatesForAthlete(actor, 'ath-1', { now: NOW });
    expect(JSON.stringify(result)).not.toContain('1990');
  });
});
