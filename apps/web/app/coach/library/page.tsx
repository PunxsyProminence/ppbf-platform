'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';

import ClusterNav from '@/components/ClusterNav';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type { ClassPlanTrackDetail, LibraryTrackSummary } from '@/src/server/pilot/classPlanShapes';

// Library: the gym's library tracks, read-only. A library track is a training
// track with no weeks or days, only text: manuals, sheets and checklists, kept
// as written. A track opens as its groups in order, each group's blocks as the
// sheet prints them. Lines the app shows beside a sheet (OD-2026-11-16-004),
// backbone differences, differences and owner passages are plain information
// in the page's own quiet text (OD-2026-11-10-001 RULES s1): nothing here
// warns, blocks or edits. This page writes nothing.

type Data = Record<string, unknown>;

const isData = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const dataListOf = (value: unknown): Data[] => listOf(value).filter(isData);
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function label(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const BODY = 't-body mt-[var(--s1)] text-[color:var(--bone-300)]';
const NOTE = 'mt-[var(--s2)] border-l-2 border-[color:rgb(var(--brass-400-rgb)_/_.22)] pl-[var(--s3)]';

/**
 * A detail value with no value says so, rather than printing "null" or a
 * blank that reads like an answer (P6, OD-2026-11-17-009). Table cells keep
 * asText: an empty cell on a sheet is a real blank on that sheet.
 */
function detailText(value: unknown): string {
  return value === null || value === undefined ? 'not set' : asText(value);
}

/** A stored detail value as text: a string, a list, or a key/value map (as on Class plans). */
function DetailValue({ value }: { readonly value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <ul className="mt-[var(--s2)] list-disc pl-[var(--s5)]">
        {value.map((entry, index) => (
          <li key={index} className="t-body text-[color:var(--bone-300)]">{detailText(entry)}</li>
        ))}
      </ul>
    );
  }
  if (isData(value)) {
    return (
      <dl className="mt-[var(--s2)]">
        {Object.entries(value).map(([key, entry]) => (
          <div key={key} className="t-body text-[color:var(--bone-300)]">
            <dt className="inline font-semibold">{key}: </dt>
            <dd className="inline">{detailText(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{detailText(value)}</p>;
}

/** A line the app shows beside a sheet's line; the sheet itself is not edited. */
function BesideLine({ line }: { readonly line: Data }) {
  const sources = listOf(line.sources).map(asText).join(', ');
  return (
    <div className={NOTE}>
      {/* Its own label, so it is told apart from a Backbone note at a glance (P6; Overwatch DFX Q2: generic wording). */}
      <p className="t-label">Shown beside the sheet</p>
      <p className={BODY}>{asText(line.line_text)}</p>
      <p className={BODY}>{`Source: ${asText(line.line_key)} (${sources})`}</p>
      {textOf(line.caveat) && <p className={BODY}>{asText(line.caveat)}</p>}
      <p className={BODY}>{`Shown beside the sheet; nothing on the sheet is edited (${asText(line.ruling)}).`}</p>
    </div>
  );
}

function BackboneNote({ difference }: { readonly difference: Data }) {
  return (
    <div className={NOTE}>
      <p className={BODY}>{`Backbone (${asText(difference.card)}): ${asText(difference.backbone)}`}</p>
      {textOf(difference.label) && <p className={BODY}>{asText(difference.label)}</p>}
    </div>
  );
}

function Difference({ difference }: { readonly difference: Data }) {
  const texts: [unknown, unknown][] = [
    [difference.text_1, difference.text_1_source ?? difference.source_1],
    [difference.text_2, difference.text_2_source ?? difference.source_2],
  ];
  return (
    <div className={NOTE}>
      <p className="t-label">{textOf(difference.card) ? `Difference (${asText(difference.card)})` : 'Difference'}</p>
      {textOf(difference.label) && <p className={BODY}>{asText(difference.label)}</p>}
      {textOf(difference.reading) && <p className={BODY}>{asText(difference.reading)}</p>}
      {texts.filter(([text]) => textOf(text)).map(([text, source], index) => (
        <p key={index} className={BODY}>{`"${asText(text)}"${textOf(source) ? ` (${asText(source)})` : ''}`}</p>
      ))}
    </div>
  );
}

const PASSAGE_TITLE_KEYS = ['doc', 'doc_title', 'source_manual', 'sheet', 'section', 'row_id'];
const PASSAGE_SKIPPED_KEYS = new Set([...PASSAGE_TITLE_KEYS, 'beside', 'read_for', 'reading_note', 'group', 'difference']);

function OwnerPassage({ passage }: { readonly passage: Data }) {
  const title = [
    [passage.doc, passage.doc_title].map(asText).filter(Boolean).join(' '),
    asText(passage.source_manual ?? passage.sheet),
    asText(passage.section ?? passage.row_id),
  ].filter(Boolean).join(' — ');
  const differences = Array.isArray(passage.difference) ? dataListOf(passage.difference) : dataListOf([passage.difference]);
  return (
    <div className="mt-[var(--s3)]">
      <p className="t-body font-semibold text-[color:var(--bone-100)]">{title}</p>
      {Object.entries(passage).filter(([key, value]) => !PASSAGE_SKIPPED_KEYS.has(key) && value !== null).map(([key, value]) => (
        Array.isArray(value) || isData(value)
          ? <div key={key} className="mt-[var(--s2)]"><p className="t-label">{label(key)}</p><DetailValue value={value} /></div>
          : <p key={key} className={BODY}><span className="font-semibold">{label(key)}: </span>{asText(value)}</p>
      ))}
      {differences.map((difference, index) => (
        <div key={index} className={NOTE}>
          {textOf(difference.label) && <p className={BODY}>{asText(difference.label)}</p>}
          {textOf(difference.reading) && <p className={BODY}>{asText(difference.reading)}</p>}
        </div>
      ))}
    </div>
  );
}

function OwnerPassages({ passages }: { readonly passages: Data[] }) {
  if (passages.length === 0) return null;
  return (
    <details className="mt-[var(--s4)]">
      {/* 55px to tap: no tap floor names <summary> (P6). Left a list item so the disclosure marker stays. */}
      <summary className="t-label min-h-[var(--tap)] cursor-pointer py-[var(--s3)]">{`Owner passages (${passages.length})`}</summary>
      {passages.map((passage, index) => <OwnerPassage key={index} passage={passage} />)}
    </details>
  );
}

function Table({ block }: { readonly block: Data }) {
  const header = listOf(block.header).map(asText);
  return (
    <div className="mt-[var(--s3)] overflow-x-auto">
      <table className="t-body w-full border-collapse text-left text-[length:var(--t-sm)] text-[color:var(--bone-200)]">
        <thead>
          <tr>{header.map((name, index) => <th key={index} className="border-b border-[color:var(--brass-700)] p-[var(--s2)]">{name}</th>)}</tr>
        </thead>
        <tbody>
          {dataListOf(block.rows).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((name, index) => <td key={index} className="border-b border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s2)] align-top">{asText(row[name])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block }: { readonly block: Data }) {
  const text = textOf(block.text);
  switch (block.type) {
    case 'subheading':
      return <h4 className="t-label mt-[var(--s4)]">{text}</h4>;
    case 'table':
      return <Table block={block} />;
    case 'preformatted':
      return (
        <pre className="t-body mt-[var(--s2)] overflow-x-auto whitespace-pre text-[length:var(--t-sm)] text-[color:var(--bone-200)]">
          {listOf(block.lines).map(asText).join('\n')}
        </pre>
      );
    case 'source':
      return <p className={`${BODY} text-[length:var(--t-xs)]`}>{`Source file: ${asText(block.file)}`}</p>;
    default:
      return text === null ? null : <p className="t-body mt-[var(--s2)] text-[color:var(--bone-200)]">{text}</p>;
  }
}

const LIST_TYPES = new Set(['bullet', 'checkbox']);

/** What a section names beside its text: the owner's rules on it, and the drills and sessions it lists. */
function GroupRefs({ group }: { readonly group: Data }) {
  const rules = dataListOf(group.owner_rules);
  const drills = dataListOf(group.drill_refs);
  const sessions = dataListOf(group.session_refs);
  const named = (title: string, refs: Data[]) => refs.length > 0 && (
    <div className="mt-[var(--s3)]">
      <p className="t-label">{title}</p>
      <ul className="mt-[var(--s1)] list-disc pl-[var(--s5)]">
        {refs.map((ref, index) => (
          <li key={index} className="t-body text-[color:var(--bone-300)]">
            {[ref.subheading, ref.name].map(asText).filter(Boolean).join(': ')}
            {textOf(ref.coach_note) ? ` (${asText(ref.coach_note)})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <>
      {rules.map((rule, index) => (
        <div key={index} className={NOTE}>
          <p className="t-label">Owner rule</p>
          <p className={BODY}>{asText(rule.rule)}</p>
          {textOf(rule.owner_text) && <p className={BODY}>{`"${asText(rule.owner_text)}"${textOf(rule.owner_source) ? ` (${asText(rule.owner_source)})` : ''}`}</p>}
          {textOf(rule.changed_by) && <p className={BODY}>{asText(rule.changed_by)}</p>}
        </div>
      ))}
      {named('Drills in this section', drills)}
      {named('Sessions in this section', sessions)}
    </>
  );
}

function Group({ group, besideLines }: { readonly group: Data; readonly besideLines: Data[] }) {
  const blocks = listOf(group.blocks);
  const blockText = (index: number) => (isData(blocks[index]) ? textOf((blocks[index] as Data).text) : null);
  const besideAt = (line: Data) => typeof line.block_index === 'number' && blockText(line.block_index) !== null
    && blockText(line.block_index) === line.sheet_text;
  const backbone = dataListOf(group.backbone_differences);
  const matchesBackbone = (difference: Data) => blocks.some((_, index) => blockText(index) !== null && blockText(index) === difference.text);

  const notesFor = (index: number): ReactNode => {
    const text = blockText(index);
    return (
      <>
        {besideLines.filter((line) => besideAt(line) && line.block_index === index).map((line, at) => <BesideLine key={`b${at}`} line={line} />)}
        {text !== null && backbone.filter((difference) => difference.text === text).map((difference, at) => <BackboneNote key={`d${at}`} difference={difference} />)}
      </>
    );
  };

  // Consecutive bullets (or checkboxes) share one list; every other block stands alone.
  const runs: { type: string; indexes: number[] }[] = [];
  blocks.forEach((block, index) => {
    if (!isData(block)) return;
    const type = typeof block.type === 'string' && LIST_TYPES.has(block.type) ? block.type : 'single';
    const last = runs.at(-1);
    if (type !== 'single' && last?.type === type) last.indexes.push(index);
    else runs.push({ type, indexes: [index] });
  });

  const unplacedBeside = besideLines.filter((line) => !besideAt(line));
  const unplacedBackbone = backbone.filter((difference) => !matchesBackbone(difference));
  return (
    <section className="mt-[var(--s6)]">
      {textOf(group.appendix_heading) && <p className="t-eyebrow">{asText(group.appendix_heading)}</p>}
      <h3 className="t-command text-[length:var(--t-md)]">{asText(group.heading)}</h3>
      {textOf(group.source) && <p className={`${BODY} text-[length:var(--t-xs)]`}>{asText(group.source)}</p>}
      {isData(group.intro) && textOf(group.intro.text) && <p className="t-body mt-[var(--s2)] text-[color:var(--bone-200)]">{asText(group.intro.text)}</p>}
      {runs.map((run) => (run.type === 'single'
        ? <div key={run.indexes[0]}><Block block={blocks[run.indexes[0]] as Data} />{notesFor(run.indexes[0])}</div>
        : (
          <ul key={run.indexes[0]} className={`mt-[var(--s2)] ${run.type === 'bullet' ? 'list-disc pl-[var(--s5)]' : 'list-none'}`}>
            {run.indexes.map((index) => (
              <li key={index} className="t-body mt-[var(--s1)] text-[color:var(--bone-200)]">
                {run.type === 'checkbox' && <span aria-hidden="true">{'☐ '}</span>}
                <span>{asText((blocks[index] as Data).text)}</span>
                {notesFor(index)}
              </li>
            ))}
          </ul>
        )))}
      {unplacedBeside.length > 0 && (
        <div className="mt-[var(--s4)]">
          <p className="t-label">Shown beside this sheet</p>
          {unplacedBeside.map((line, index) => <BesideLine key={index} line={line} />)}
        </div>
      )}
      {unplacedBackbone.map((difference, index) => <BackboneNote key={index} difference={difference} />)}
      {dataListOf(group.differences).map((difference, index) => <Difference key={index} difference={difference} />)}
      <GroupRefs group={group} />
    </section>
  );
}

// Rendered by the page itself (top, groups, passages), or not shown (session_refs).
const OWN_KEYS = new Set([
  'part_heading', 'chapter_heading', 'subtitle', 'publisher_line', 'groups', 'differences', 'owner_passages', 'beside_lines', 'session_refs',
]);

function LibraryTrack({ detail }: { readonly detail: ClassPlanTrackDetail }) {
  const details = detail.details;
  const groups = dataListOf(details.groups);
  const besideLines = dataListOf(details.beside_lines);
  const passages = dataListOf(details.owner_passages);
  // A group without a section takes no beside line or passage; those show at the end, never dropped.
  const sectionOf = (group: Data) => textOf(group.section);
  const sections = new Set(groups.map(sectionOf).filter((section): section is string => section !== null));
  const known = (value: unknown) => textOf(value) !== null && sections.has(value as string);
  const inGroup = (value: unknown, group: Data) => sectionOf(group) !== null && value === sectionOf(group);
  const strayBeside = besideLines.filter((line) => !known(line.group_section));
  const strayPassages = passages.filter((passage) => !known(passage.group));
  const about = Object.entries(details).filter(([key]) => !OWN_KEYS.has(key));
  return (
    <>
      {(['part_heading', 'chapter_heading', 'subtitle', 'publisher_line'] as const).map((key) => (
        textOf(details[key]) ? <p key={key} className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{asText(details[key])}</p> : null
      ))}
      {dataListOf(details.differences).map((difference, index) => <Difference key={index} difference={difference} />)}
      {groups.length === 0 && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">This track has no text sections.</p>}
      {groups.map((group, index) => (
        <div key={index}>
          <Group group={group} besideLines={besideLines.filter((line) => inGroup(line.group_section, group))} />
          <OwnerPassages passages={passages.filter((passage) => inGroup(passage.group, group))} />
        </div>
      ))}
      {strayBeside.length > 0 && (
        <div className="mt-[var(--s6)]">
          <p className="t-label">Shown beside the sheets</p>
          {strayBeside.map((line, index) => <BesideLine key={index} line={line} />)}
        </div>
      )}
      <OwnerPassages passages={strayPassages} />
      {about.length > 0 && (
        <div className="mt-[var(--s6)]">
          <h3 className="t-command text-[length:var(--t-md)]">About this track</h3>
          <div className="mt-[var(--s3)] flex flex-col gap-[var(--s4)]">
            {about.map(([key, value]) => (
              <div key={key}><p className="t-label">{label(key)}</p><DetailValue value={value} /></div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Library() {
  const [tracks, setTracks] = useState<LibraryTrackSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openTrackId, setOpenTrackId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClassPlanTrackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // Only the latest open may change what is shown (two taps on slow wifi).
  const detailRead = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-tracks?library=1`, { method: 'GET', credentials: 'include' });
      if (!response.ok) throw new Error('The library could not be loaded.');
      const payload = (await response.json()) as { tracks?: LibraryTrackSummary[] };
      setTracks(payload.tracks ?? []);
      setLoadError('');
    } catch (error) {
      setTracks([]);
      setLoadError(error instanceof Error ? error.message : 'The library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openTrack = useCallback(async (trackId: string) => {
    detailRead.current += 1;
    const thisRead = detailRead.current;
    setOpenTrackId(trackId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/training-tracks?track=${encodeURIComponent(trackId)}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('This track could not be loaded.');
      const payload = (await response.json()) as { track?: ClassPlanTrackDetail };
      if (detailRead.current !== thisRead) return;
      if (!payload.track) throw new Error('This track could not be loaded.');
      setDetail(payload.track);
    } catch (error) {
      if (detailRead.current !== thisRead) return;
      setDetailError(error instanceof Error ? error.message : 'This track could not be loaded.');
    } finally {
      if (detailRead.current === thisRead) setDetailLoading(false);
    }
  }, []);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]" data-surface="kiosk">
      <div className="mx-auto max-w-5xl">
      <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
        <p className="t-eyebrow">Coach Workspace</p>
        <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Library</h1>
        <ClusterNav cluster="planning" />
        <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
          The gym&apos;s manuals, sheets and checklists, shown as written. This page only reads.
        </p>
        <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/class-plans" className="btn btn--ghost">Class plans</Link>
        </div>
      </header>

      <section className="mt-[var(--s6)]">
        <h2 className="t-command text-[length:var(--t-lg)]">Tracks</h2>
        {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}
        {!loading && loadError && (
          <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{loadError}</p>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              This is a failure to load, not an empty library.
            </p>
          </div>
        )}
        {!loading && !loadError && tracks.length === 0 && (
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No library tracks are loaded in this environment yet.</p>
        )}
        <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
          {tracks.map((track) => (
            <article key={track.track_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
              <h3 className="t-command text-[length:var(--t-md)]">{track.name}</h3>
              {(track.part_heading || track.chapter_heading) && (
                <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                  {[track.part_heading, track.chapter_heading].filter(Boolean).join(' · ')}
                </p>
              )}
              <p className={BODY}>{track.age_band}</p>
              <button
                type="button"
                className="btn btn--ghost mt-[var(--s3)]"
                onClick={() => void openTrack(track.track_id)}
                disabled={openTrackId === track.track_id && detail !== null}
              >
                {openTrackId === track.track_id ? 'Showing' : 'Open'}
              </button>
            </article>
          ))}
        </div>
      </section>

      {openTrackId !== null && (
        <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">{detail ? detail.name : 'Library track'}</h2>
          {detailLoading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the track...</p>}
          {!detailLoading && detailError && (
            <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
              {detailError}
            </p>
          )}
          {!detailLoading && !detailError && detail && <LibraryTrack detail={detail} />}
        </section>
      )}
      </div>
    </main>
  );
}

export default function LibraryPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <Library />
    </RoleSessionGate>
  );
}
