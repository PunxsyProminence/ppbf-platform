'use client';

import { useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import type { SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';

// Changing a plan: its name, and each block's title and minutes (lane L1).
//
// Blocks are not added, removed or reordered here, and the minutes stay what
// the page shows everywhere else: minutes from the start of the session, a
// start and an end, never a clock time.
//
// ONLY WHAT WAS CHANGED IS SENT. The name goes only if it was retyped, and a
// block only if its title or minutes were; the server keeps the rest. So a
// block nobody touched is never re-judged, and a save with nothing changed is
// answered "unchanged" instead of making a new version of a delivered plan.
//
// WHAT SAVING DID IS THE SERVER'S ANSWER, and it is said back as given
// (sessionScriptAuthoring.ts). A plan nobody has delivered is changed where it
// is. A plan that has been delivered is not changed: the save becomes its next
// version. A plan another coach saved since this form opened is refused, and
// that coach's save is left as it is.
//
// THE FORM NEVER SAYS "NOTHING WAS SAVED" UNLESS THE SERVER SAID SO:
//   - 2xx: saved, always -- even when the answer cannot be read;
//   - a refusal by one of the statuses this route refuses with (the list
//     below): nothing was saved;
//   - anything else -- no answer, a fault, or another 4xx such as a rate limit
//     from something in between, whatever its body says: not known, and said so.
//
// NOT THE MEDICAL-STOP COLOUR: --locked means a medical stop and nothing else
// (AGENT_KERNEL.md, OD-2026-09-29-001). The alert is brass and bone, and its
// words carry the meaning.

export type SessionScriptEditOutcome = 'unchanged' | 'updated' | 'new_version';

interface BlockDraft {
  block_id: string;
  label: string;
  start: string;
  end: string;
}

// The server's own ceiling on a block's minutes (sessionScriptAuthoring.ts MAX_OFFSET_MIN).
const LAST_MINUTE = 24 * 60;

// What PATCH /api/pilot/session-scripts answers when it refuses before or
// inside its transaction.
const REFUSAL_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422];

const REFUSALS_BY_STATUS: Readonly<Record<number, string>> = {
  401: 'You are signed out, so nothing was saved. Sign in, open the plan again and make your changes.',
  403: 'Your account may not edit session plans, so nothing was saved.',
};

const REFUSALS: Readonly<Record<string, string>> = {
  SESSION_SCRIPT_CHANGED:
    'This plan was saved after you opened it, on another screen or by another coach, so nothing of yours was saved and that save is as it was left. Open the plan again to see it, then make your changes.',
  SESSION_SCRIPT_SUPERSEDED:
    'This plan has been replaced by a newer version, so nothing was saved. Reload the list and edit the current version.',
  SESSION_SCRIPT_NOT_FOUND: 'This plan could not be found, so nothing was saved.',
  SESSION_SCRIPT_BLOCK_MINUTES_INVALID:
    `Nothing was saved. Each block needs whole minutes from the start of the session, its end after its start and no later than minute ${LAST_MINUTE}.`,
  SESSION_SCRIPT_BLOCK_LABEL_INVALID: 'Nothing was saved. Every block needs a title of 200 characters or fewer.',
  SESSION_SCRIPT_NAME_INVALID: 'Nothing was saved. The plan needs a name of 200 characters or fewer.',
};

function wholeMinutes(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

export default function SessionScriptEditor({
  script,
  onSaved,
  onCancel,
  onBusyChange,
}: {
  readonly script: SessionScriptWithDetail;
  /** `saved` is null when the server saved but its answer could not be read. */
  readonly onSaved: (outcome: SessionScriptEditOutcome | null, saved: SessionScriptWithDetail | null) => void;
  readonly onCancel: () => void;
  /** Told while a save is running, so the page keeps this form on screen until it answers. */
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(script.name);
  const [blocks, setBlocks] = useState<BlockDraft[]>(() =>
    script.blocks.map((block) => ({
      block_id: block.block_id,
      label: block.block_label,
      start: String(block.start_offset_min),
      end: String(block.end_offset_min),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One save per press: `busy` disables the button only after a render.
  const inFlight = useRef(false);

  const change = (blockId: string, field: 'label' | 'start' | 'end', value: string) => {
    setBlocks((current) => current.map((block) => (block.block_id === blockId ? { ...block, [field]: value } : block)));
  };

  const save = async () => {
    if (inFlight.current) return;
    setError('');

    // Said here, by block, before anything is sent; the server checks the same things.
    const nameChanged = name !== script.name;
    if (nameChanged && name.trim() === '') {
      setError('The plan needs a name.');
      return;
    }
    const edits = [];
    for (const [index, block] of blocks.entries()) {
      const stored = script.blocks[index];
      if (
        block.label === stored.block_label
        && block.start === String(stored.start_offset_min)
        && block.end === String(stored.end_offset_min)
      ) {
        continue;
      }
      const start = wholeMinutes(block.start);
      const end = wholeMinutes(block.end);
      if (block.label.trim() === '') {
        setError(`Block ${index + 1} needs a title.`);
        return;
      }
      if (start === null || end === null || end <= start) {
        setError(`Block ${index + 1} needs whole minutes, with its end after its start.`);
        return;
      }
      if (end > LAST_MINUTE) {
        setError(`Block ${index + 1} ends after minute ${LAST_MINUTE}, the longest a plan can run.`);
        return;
      }
      edits.push({ block_id: block.block_id, block_label: block.label, start_offset_min: start, end_offset_min: end });
    }

    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            script_id: script.script_id,
            // Which state of the plan this form was opened on: the two-coaches check.
            expected_updated_at: script.updated_at,
            ...(nameChanged ? { name } : {}),
            ...(edits.length > 0 ? { blocks: edits } : {}),
          }),
        });
      } catch {
        setError('No answer arrived, so it is not known whether the plan was saved. Reload the list to see which.');
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        outcome?: SessionScriptEditOutcome;
        script?: SessionScriptWithDetail | null;
        error?: unknown;
      } | null;
      if (response.ok) {
        if (payload?.outcome !== undefined && payload.script) onSaved(payload.outcome, payload.script);
        else onSaved(null, null);
        return;
      }
      if (REFUSAL_STATUSES.includes(response.status)) {
        const code = typeof payload?.error === 'string' ? payload.error : '';
        setError(REFUSALS[code] ?? REFUSALS_BY_STATUS[response.status] ?? 'The server refused, so nothing was saved.');
        return;
      }
      setError('The server did not answer properly, so it is not known whether the plan was saved. Reload the list to see which.');
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <form
      aria-label="Edit plan"
      className="mt-[var(--s4)] flex flex-col gap-[var(--s4)]"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span className="t-label">Plan name</span>
        <input type="text" className="input" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>

      <ol aria-label="Blocks to edit, in the order they run" className="flex flex-col gap-[var(--s3)]">
        {blocks.map((block, index) => (
          <li
            key={block.block_id}
            className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
          >
            <fieldset className="flex flex-wrap items-end gap-[var(--s3)]">
              <legend className="t-label">Block {index + 1}</legend>
              <label className="field min-w-[14rem] flex-1">
                <span className="t-label">Title</span>
                <input
                  type="text"
                  className="input"
                  value={block.label}
                  maxLength={200}
                  onChange={(event) => change(block.block_id, 'label', event.target.value)}
                />
              </label>
              <label className="field w-[8rem]">
                <span className="t-label">Starts at minute</span>
                <input
                  type="text"
                  className="input"
                  inputMode="numeric"
                  value={block.start}
                  onChange={(event) => change(block.block_id, 'start', event.target.value)}
                />
              </label>
              <label className="field w-[8rem]">
                <span className="t-label">Ends at minute</span>
                <input
                  type="text"
                  className="input"
                  inputMode="numeric"
                  value={block.end}
                  onChange={(event) => change(block.block_id, 'end', event.target.value)}
                />
              </label>
            </fieldset>
          </li>
        ))}
      </ol>

      {error && (
        <p role="alert" className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-[var(--s3)]">
        <button type="submit" disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? 'Saving…' : 'Save plan'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60">
          Cancel
        </button>
      </div>
    </form>
  );
}
