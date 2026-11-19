'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatMediaOffset } from '@/src/lib/clipTime';

/**
 * Pick a calibration clip (lane SH, BOA-01).
 *
 * The Calibration Review and Calibration Adjudication pages need a
 * calibration_clip_id in the address. Opened from the building map, they had
 * none and said "No clip named", a dead end: the only links that carried a
 * clip were on those same two pages. This picker lists the gym's studies and
 * a study's clips, from the same two reads the Teach SHADOW annotation page
 * uses (GET /api/pilot/calibration/projects and /clips; requireAnnotator:
 * coach and organization admin), and opens the page it sits on with the
 * chosen clip. It reads nothing about any annotation and writes nothing.
 */

interface StudyRow {
  calibration_project_id: string;
  name: string;
}

interface ClipRow {
  calibration_clip_id: string;
  clip_code: string;
  start_ms: number;
  end_ms: number;
}

type ReadState = 'idle' | 'reading' | 'ready' | 'failed';

interface CalibrationClipPickerProps {
  /** The page this picker opens with the chosen clip, e.g. /admin/calibration/review. */
  readonly basePath: string;
}

function isStudyRow(row: unknown): row is StudyRow {
  const r = row as Partial<StudyRow> | null;
  return !!r && typeof r.calibration_project_id === 'string' && r.calibration_project_id !== '' && typeof r.name === 'string';
}

function isClipRow(row: unknown): row is ClipRow {
  const r = row as Partial<ClipRow> | null;
  return (
    !!r
    && typeof r.calibration_clip_id === 'string'
    && r.calibration_clip_id !== ''
    && typeof r.clip_code === 'string'
    && typeof r.start_ms === 'number'
    && typeof r.end_ms === 'number'
  );
}

export function clipOptionLabel(clip: ClipRow): string {
  return `${clip.clip_code} · ${formatMediaOffset(clip.start_ms)} to ${formatMediaOffset(clip.end_ms)}`;
}

export default function CalibrationClipPicker({ basePath }: CalibrationClipPickerProps) {
  const [studiesState, setStudiesState] = useState<ReadState>('reading');
  const [studies, setStudies] = useState<StudyRow[]>([]);
  const [studyId, setStudyId] = useState('');
  const [clipsState, setClipsState] = useState<ReadState>('idle');
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [clipId, setClipId] = useState('');
  // A clip list that answers after the study was changed again is dropped.
  const clipsSeq = useRef(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/calibration/projects`, { credentials: 'include' });
        const payload = (await response.json().catch(() => null)) as { projects?: unknown } | null;
        if (!live) return;
        // UXB-24: an answer this picker cannot read -- no list, or any row
        // without the fields it needs -- is "could not be read", never "none".
        if (!response.ok || !Array.isArray(payload?.projects) || !payload.projects.every(isStudyRow)) {
          setStudiesState('failed');
          return;
        }
        setStudies(payload.projects);
        setStudiesState('ready');
      } catch {
        if (live) setStudiesState('failed');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const chooseStudy = async (next: string) => {
    const seq = ++clipsSeq.current;
    setStudyId(next);
    setClipId('');
    setClips([]);
    if (!next) {
      setClipsState('idle');
      return;
    }
    setClipsState('reading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/calibration/clips?calibration_project_id=${encodeURIComponent(next)}`,
        { credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as { clips?: unknown } | null;
      if (seq !== clipsSeq.current) return;
      if (!response.ok || !Array.isArray(payload?.clips) || !payload.clips.every(isClipRow)) {
        setClipsState('failed');
        return;
      }
      // Only the code and times are kept: the athlete and footage ids on a
      // clip row never reach this picker's screen.
      setClips(payload.clips.map(({ calibration_clip_id, clip_code, start_ms, end_ms }) => ({
        calibration_clip_id,
        clip_code,
        start_ms,
        end_ms,
      })));
      setClipsState('ready');
    } catch {
      if (seq === clipsSeq.current) setClipsState('failed');
    }
  };

  return (
    <section aria-labelledby="calibration-clip-picker-heading" className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
      <h2 id="calibration-clip-picker-heading" className="t-command" style={{ fontSize: 'var(--t-md)' }}>
        Pick a clip
      </h2>

      {studiesState === 'reading' && <p className="working">Reading studies</p>}
      {studiesState === 'failed' && (
        <p className="t-body" role="alert">
          <span aria-hidden="true">▲ </span>Studies could not be read. Reload to try again.
        </p>
      )}
      {studiesState === 'ready' && studies.length === 0 && (
        <p className="t-body">No studies yet. Studies are made on the Teach SHADOW annotation page.</p>
      )}

      {studiesState === 'ready' && studies.length > 0 && (
        <div className="grid gap-[var(--s4)] md:grid-cols-2">
          <div className="field">
            <label htmlFor="calibration-picker-study" className="t-label">Study</label>
            <select
              id="calibration-picker-study"
              className="select"
              value={studyId}
              onChange={(e) => void chooseStudy(e.target.value)}
            >
              <option value="">Choose a study</option>
              {studies.map((study) => (
                <option key={study.calibration_project_id} value={study.calibration_project_id}>
                  {study.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="calibration-picker-clip" className="t-label">Clip</label>
            <select
              id="calibration-picker-clip"
              className="select"
              value={clipId}
              disabled={clipsState !== 'ready' || clips.length === 0}
              onChange={(e) => setClipId(e.target.value)}
            >
              <option value="">Choose a clip</option>
              {clips.map((clip) => (
                <option key={clip.calibration_clip_id} value={clip.calibration_clip_id}>
                  {clipOptionLabel(clip)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {clipsState === 'reading' && <p className="working">Reading clips</p>}
      {clipsState === 'failed' && (
        <p className="t-body" role="alert">
          <span aria-hidden="true">▲ </span>Clips could not be read. Reload to try again.
        </p>
      )}
      {clipsState === 'ready' && clips.length === 0 && <p className="t-body">This study has no clips yet.</p>}

      {studiesState === 'ready' && studies.length > 0 && (
        clipId ? (
          <Link href={`${basePath}?calibration_clip_id=${encodeURIComponent(clipId)}`} className="btn">
            Open clip
          </Link>
        ) : (
          <button type="button" className="btn disabled:cursor-not-allowed disabled:opacity-60" disabled>
            Open clip
          </button>
        )
      )}
    </section>
  );
}
