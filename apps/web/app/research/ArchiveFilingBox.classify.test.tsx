/**
 * @jest-environment jsdom
 */

// Lane LR6 (issue #345, PR "I"). A source that arrived with no R01-R19 subject
// (the seed importer, for one) is refused filing: "Classify this source first".
// Before this, the only classify screen was on the General Research tab, which
// does not list such a source, so its PDF could not be filed from the app. These
// pin that the filing box now offers the subject picker in place, saves the pick
// through the same sources PATCH, and files once more.

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { RESEARCH_CLASSIFICATION_DOMAINS } from '@/src/shared/researchClassification';
import type { FiledOriginal } from '@/src/client/libraryTextIntake';

import ArchiveFilingBox, { FILING_WORDS } from './ArchiveFilingBox';

const NOT_CLASSIFIED = {
  status: 409,
  json: { error: 'Classify this source first: its subject decides the Research Archive folder.', code: 'SOURCE_NOT_CLASSIFIED' },
};
const FILED_ANSWER = {
  status: 201,
  json: {
    ok: true,
    status: 'filed',
    archived_original: {
      archived_original_id: 'arc_11111111-2222-3333-4444-555555555555',
      source_id: 'source_a',
      archive_domain_code: 'R01',
      archive_filename: 'paper--aaaaaaaaaaaa.pdf',
      web_url: null,
      content_sha256: 'a'.repeat(64),
    },
  },
};
const PICKER = FILING_WORDS.classifyLabel;

type Answer = { status: number; json: unknown };
interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Answers each POST (filing) and PATCH (classify) from its own queue, in order. */
function installFetch(answers: { post: Answer[]; patch?: Array<Answer | Promise<Answer>> }) {
  const calls: Call[] = [];
  const post = [...answers.post];
  const patch = [...(answers.patch ?? [])];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const isForm = init?.body instanceof FormData;
    calls.push({
      url: String(input),
      method,
      body: !isForm && init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = method === 'PATCH' ? patch.shift() : post.shift();
    if (next === undefined) throw new Error(`unexpected ${method} ${String(input)}`);
    const answer = await next;
    return { status: answer.status, ok: answer.status < 400, json: async () => answer.json } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const filingCalls = (calls: Call[]) => calls.filter((call) => call.method === 'POST');
const classifyCalls = (calls: Call[]) => calls.filter((call) => call.method === 'PATCH');

function renderBox(props: { sourceId?: string; shelf?: 'platform'; onFiled?: (original: FiledOriginal) => void } = {}) {
  const file = new File(['%PDF-1.7 body'], 'paper.pdf', { type: 'application/pdf' });
  const onFiled = props.onFiled ?? jest.fn();
  const element = (sourceId: string) => (
    <ArchiveFilingBox file={file} sourceId={sourceId} shelf={props.shelf} disabled={false}
      filed={null} linkState="linked" onFiled={onFiled} />
  );
  const view = render(element(props.sourceId ?? 'source_a'));
  return { onFiled, rerenderFor: (sourceId: string) => view.rerender(element(sourceId)) };
}

async function fileIt() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: FILING_WORDS.file }));
  });
}

async function pick(key: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(PICKER), { target: { value: key } });
  });
}

describe('ArchiveFilingBox: classifying an unclassified source in place (lane LR6)', () => {
  it('shows the picker when the archive says the source is not classified', async () => {
    installFetch({ post: [NOT_CLASSIFIED] });
    renderBox();
    expect(screen.queryByLabelText(PICKER)).toBeNull();

    await fileIt();

    expect(screen.getByLabelText(PICKER)).toBeTruthy();
    // The existing refusal stays on screen beside it.
    expect(screen.getByRole('alert').textContent).toBe(FILING_WORDS.notFiled(NOT_CLASSIFIED.json.error));
  });

  it.each([
    ['another 409', { status: 409, json: { error: 'Already filed.', code: 'ARCHIVE_ALREADY_FILED' } }],
    ['a 404 for the source', { status: 404, json: { error: 'That Library source was not found on this shelf.', code: 'SOURCE_NOT_FOUND' } }],
    ['a refusal with no code', { status: 403, json: { error: 'Forbidden' } }],
    ['a server error', { status: 502, json: { error: 'The Research Archive did not confirm the filing.' } }],
  ])('does not show it for %s', async (_name, answer) => {
    installFetch({ post: [answer] });
    renderBox();
    await fileIt();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText(PICKER)).toBeNull();
  });

  it('offers the R01-R19 subjects from the shared list, and neither R00 nor R98', async () => {
    installFetch({ post: [NOT_CLASSIFIED] });
    renderBox();
    await fileIt();

    const options = within(screen.getByLabelText(PICKER)).getAllByRole('option') as HTMLOptionElement[];
    const subjects = options.filter((option) => option.value !== '');
    expect(subjects.map((option) => option.value)).toEqual(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.key));
    expect(subjects).toHaveLength(19);
    expect(options[0].textContent).toBe(FILING_WORDS.classifyPlaceholder);
    // Each rendered subject is a folder R01-R19; the workflow states R00 and R98 are not among them.
    const codes = subjects.map((option) => RESEARCH_CLASSIFICATION_DOMAINS.find((domain) => domain.key === option.value)?.archiveCode);
    expect(codes).toEqual(Array.from({ length: 19 }, (_unused, index) => `R${String(index + 1).padStart(2, '0')}`));
    expect(codes).not.toContain('R00');
    expect(codes).not.toContain('R98');
  });

  it('saves the pick through the sources PATCH, then files once more, once', async () => {
    const onFiled = jest.fn();
    const calls = installFetch({ post: [NOT_CLASSIFIED, FILED_ANSWER], patch: [{ status: 200, json: { ok: true } }] });
    renderBox({ onFiled });
    await fileIt();
    await pick('boxing_athlete_development');

    expect(calls.map((call) => call.method)).toEqual(['POST', 'PATCH', 'POST']);
    expect(calls[1].url).toMatch(/\/api\/pilot\/shadow\/library\/sources$/);
    expect(calls[1].body).toEqual({ source_id: 'source_a', classification_domain: 'boxing_athlete_development' });
    expect(onFiled).toHaveBeenCalledTimes(1);
    expect(onFiled.mock.calls[0][0]).toMatchObject({ sourceId: 'source_a', archiveDomainCode: 'R01' });
    expect(screen.queryByLabelText(PICKER)).toBeNull();
  });

  it('names the platform shelf on the PATCH when filing for it', async () => {
    const calls = installFetch({ post: [NOT_CLASSIFIED, FILED_ANSWER], patch: [{ status: 200, json: { ok: true } }] });
    renderBox({ shelf: 'platform' });
    await fileIt();
    await pick('ai_ml_data_science');

    expect(classifyCalls(calls)[0].body).toEqual({
      source_id: 'source_a',
      classification_domain: 'ai_ml_data_science',
      shelf: 'platform',
    });
  });

  it('a refusal on the PATCH is shown, and the filing is not tried again', async () => {
    const onFiled = jest.fn();
    const calls = installFetch({
      post: [NOT_CLASSIFIED],
      patch: [{ status: 403, json: { error: 'Forbidden' } }],
    });
    renderBox({ onFiled });
    await fileIt();
    await pick('boxing_athlete_development');

    // The route's own sentence has no full stop; the box sets one.
    expect(screen.getByRole('alert').textContent).toBe('Not classified: Forbidden. Nothing was filed.');
    expect(FILING_WORDS.notClassified('A sentence that has its stop.')).toBe('Not classified: A sentence that has its stop. Nothing was filed.');
    expect(filingCalls(calls)).toHaveLength(1);
    expect(classifyCalls(calls)).toHaveLength(1);
    expect(onFiled).not.toHaveBeenCalled();
    // Still there to try again.
    expect(screen.getByLabelText(PICKER)).toBeTruthy();
  });

  it('a PATCH nobody answered says so in the box words, and files nothing more', async () => {
    const calls = installFetch({ post: [NOT_CLASSIFIED], patch: [{ status: 500, json: {} }] });
    renderBox();
    await fileIt();
    await pick('boxing_athlete_development');

    expect(screen.getByRole('alert').textContent).toBe(FILING_WORDS.notClassified(FILING_WORDS.classifyFailed));
    expect(filingCalls(calls)).toHaveLength(1);
  });

  it('files only once after a pick, even when the answer is not classified again', async () => {
    const calls = installFetch({ post: [NOT_CLASSIFIED, NOT_CLASSIFIED], patch: [{ status: 200, json: { ok: true } }] });
    renderBox();
    await fileIt();
    await pick('boxing_athlete_development');

    expect(filingCalls(calls)).toHaveLength(2);
    expect(classifyCalls(calls)).toHaveLength(1);
  });

  it('a second change while the first is being saved sends nothing', async () => {
    let answerPatch: (answer: Answer) => void = () => undefined;
    const slow = new Promise<Answer>((resolve) => {
      answerPatch = resolve;
    });
    const calls = installFetch({ post: [NOT_CLASSIFIED, FILED_ANSWER], patch: [slow] });
    renderBox();
    await fileIt();
    await act(async () => {
      fireEvent.change(screen.getByLabelText(PICKER), { target: { value: 'boxing_athlete_development' } });
      fireEvent.change(screen.getByLabelText(PICKER), { target: { value: 'ai_ml_data_science' } });
    });
    expect((screen.getByLabelText(PICKER) as HTMLSelectElement).disabled).toBe(true);
    await act(async () => {
      answerPatch({ status: 200, json: { ok: true } });
    });

    expect(classifyCalls(calls)).toHaveLength(1);
    expect(classifyCalls(calls)[0].body).toMatchObject({ classification_domain: 'boxing_athlete_development' });
    expect(filingCalls(calls)).toHaveLength(2);
  });

  it('is for the source the archive refused: choosing another source takes it away', async () => {
    installFetch({ post: [NOT_CLASSIFIED] });
    const { rerenderFor } = renderBox({ sourceId: 'source_a' });
    await fileIt();
    expect(screen.getByLabelText(PICKER)).toBeTruthy();

    rerenderFor('source_b');

    expect(screen.queryByLabelText(PICKER)).toBeNull();
  });
});
