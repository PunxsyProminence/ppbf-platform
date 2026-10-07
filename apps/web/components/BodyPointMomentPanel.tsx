'use client';

import {
  BODY_POINT_PLACEMENT_NOTES,
  GUARD_TYPES,
  GUARD_TYPE_SOURCES,
  LEAD_SIDES,
  SOURCE_MANUALS,
  type BodyPoint,
} from '@/src/server/pilot/calibration/ontology';
import { formatMediaOffset } from '@/src/lib/clipTime';

import { namedPositionLabel } from './BodyPointProgress';

/**
 * ONE MOMENT'S CONTROLS: the point list in marking order, the lead side and
 * the guard. The picture itself (the tap layer) sits on the video, not here;
 * this panel says which point the next tap is for and holds the buttons that
 * are not taps.
 *
 * Every point is named in full here ("left glove", with its placement note
 * where Jason gave one), at the page's text size, because the short labels
 * on the picture are beside a dot and small. Left and right are spelled out
 * (OD-2026-10-02-011 3b); nothing says lead or rear.
 *
 * No point is ever placed by this panel. "Place" only chooses which point the
 * next tap on the picture is for; "Not visible" is the coach's own
 * observation, recorded as such (OD-2026-10-02-011 3a); "Clear" removes a
 * mark so the point is unmarked again, which is not a state the server knows
 * -- it is the absence of a row, and the set cannot be submitted with it.
 */

export interface PanelPoint {
  point_code: string;
  state: string;
  x_norm: number | null;
  y_norm: number | null;
}

export interface PanelMoment {
  body_moment_id: string;
  moment_slot: string;
  moment_kind: string;
  observation_ms: number;
  lead_side: string | null;
  guard_type: string | null;
  points: readonly PanelPoint[];
}

export interface BodyPointMomentPanelProps {
  moment: PanelMoment;
  /** The set's point list, in marking order. */
  expectedPoints: readonly string[];
  activePointCode: string | null;
  /** True while a save is in flight or the set is read-only. */
  disabled: boolean;
  canUndo: boolean;
  /** The playhead is not on the moment: the tap layer is off until it is. */
  awayFromMoment: boolean;
  onSelectPoint: (pointCode: string) => void;
  onNotVisible: (pointCode: string) => void;
  onClearPoint: (pointCode: string) => void;
  onUndo: () => void;
  onSetLeadSide: (leadSide: string) => void;
  onSetGuard: (guardType: string) => void;
  onGoToMoment: () => void;
  onClose: () => void;
}

/** "left_glove" -> "left glove". Display only. */
function label(token: string): string {
  return token.replace(/_/g, ' ');
}

/** The option text for a named guard or stance: the manual's heading, the
 * body, and where to read it ("Half Guard, USA Boxing, p. 82 (PDF 83)"). */
export function namedPositionOption(token: string): string {
  const source = (GUARD_TYPE_SOURCES as Record<string, { body: keyof typeof SOURCE_MANUALS; printedPage: number | null; pdfPage: number | null } | undefined>)[token];
  if (!source) return namedPositionLabel(token);
  const printed = source.printedPage === null ? 'page not settled' : `p. ${source.printedPage}`;
  const pdf = source.pdfPage === null ? '' : ` (PDF ${source.pdfPage})`;
  return `${namedPositionLabel(token)}, ${printed}${pdf}`;
}

const CHOOSE = '— choose —';

export default function BodyPointMomentPanel({
  moment,
  expectedPoints,
  activePointCode,
  disabled,
  canUndo,
  awayFromMoment,
  onSelectPoint,
  onNotVisible,
  onClearPoint,
  onUndo,
  onSetLeadSide,
  onSetGuard,
  onGoToMoment,
  onClose,
}: BodyPointMomentPanelProps) {
  const byCode = new Map(moment.points.map((point) => [point.point_code, point]));
  const marked = moment.points.length;

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]" data-testid="body-point-moment-panel">
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h2 className="t-eyebrow">
          Marking the {label(moment.moment_slot)} moment ({label(moment.moment_kind)} at{' '}
          {formatMediaOffset(moment.observation_ms)})
        </h2>
        <span className={marked === expectedPoints.length ? 'badge badge--cleared' : 'badge badge--monitor'}>
          {marked} of {expectedPoints.length} points
        </span>
      </div>

      {awayFromMoment ? (
        <div className="alert alert--warning mt-[var(--s3)]" role="status">
          <div className="alert-body">
            <p className="t-body">
              The playhead is not on this moment. Taps place nothing until it is.
            </p>
            <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={onGoToMoment}>
              Go to the moment
            </button>
          </div>
        </div>
      ) : (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]" data-testid="body-point-next">
          {activePointCode
            ? `Tap the picture to place ${label(activePointCode)}${
              BODY_POINT_PLACEMENT_NOTES[activePointCode as BodyPoint]
                ? ` (${BODY_POINT_PLACEMENT_NOTES[activePointCode as BodyPoint]})`
                : ''
            }.`
            : 'Every point on this moment is marked. Set the lead side and the guard, then open the next moment.'}
        </p>
      )}

      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
        <button type="button" className="btn btn--ghost" disabled={disabled || !canUndo} onClick={onUndo}>
          Undo last placement
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close this moment
        </button>
      </div>

      <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
        <div className="field">
          <label htmlFor="moment-lead-side" className="t-label">Lead side at this moment</label>
          <select
            id="moment-lead-side"
            className="select"
            value={moment.lead_side ?? ''}
            disabled={disabled}
            onChange={(e) => onSetLeadSide(e.target.value)}
          >
            <option value="">{CHOOSE}</option>
            {LEAD_SIDES.map((value) => (
              <option key={value} value={value}>{label(value)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="moment-guard" className="t-label">Guard at this moment</label>
          <select
            id="moment-guard"
            className="select"
            value={moment.guard_type ?? ''}
            disabled={disabled}
            onChange={(e) => onSetGuard(e.target.value)}
          >
            <option value="">{CHOOSE}</option>
            {GUARD_TYPES.map((value) => (
              <option key={value} value={value}>{namedPositionOption(value)}</option>
            ))}
          </select>
        </div>
      </div>

      <ol className="mt-[var(--s3)] space-y-[var(--s2)]" data-testid="body-point-list">
        {expectedPoints.map((code) => {
          const point = byCode.get(code);
          const isActive = code === activePointCode;
          const note = BODY_POINT_PLACEMENT_NOTES[code as BodyPoint];
          let state = 'not marked';
          if (point?.state === 'placed') state = 'placed';
          if (point?.state === 'not_visible') state = 'not visible';
          return (
            <li
              key={code}
              data-testid="body-point-row"
              data-point-code={code}
              data-state={state}
              className={`flex flex-wrap items-center justify-between gap-[var(--s2)] rounded-[var(--r-sm)] border p-[var(--s2)] ${
                isActive ? 'border-[color:var(--brass-300)]' : 'border-[color:rgba(255,255,255,.12)]'
              }`}
            >
              <span className="t-body">
                {label(code)}
                {note ? <span className="t-muted"> · {note}</span> : null}
                {' '}· <span data-testid="body-point-state">{state}</span>
              </span>
              <span className="flex gap-[var(--s2)]">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={disabled || isActive}
                  aria-pressed={isActive}
                  onClick={() => onSelectPoint(code)}
                >
                  {isActive ? 'Placing' : 'Place'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={disabled || point?.state === 'not_visible'}
                  onClick={() => onNotVisible(code)}
                >
                  Not visible
                </button>
                {point ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={disabled}
                    onClick={() => onClearPoint(code)}
                  >
                    Clear
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
