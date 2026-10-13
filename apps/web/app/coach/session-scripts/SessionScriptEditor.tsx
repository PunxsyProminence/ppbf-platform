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
// WHAT SAVING DOES IS THE SERVER'S ANSWER, and it is said back as given. A plan
// nobody has delivered is changed where it is. A plan that has been delivered
// is not changed: the save becomes its next version, and the nights already
// delivered keep the version they ran (sessionScriptAuthoring.ts). The coach is
// told which happened rather than left to guess from the list.

export type SessionScriptEditOutcome = 'unchanged' | 'updated' | 'new_version';

interface BlockDraft {
  block_id: string;
  label: string;
  start: string;
  end: string;
}

const REFUSALS: Readonly<Record<string, string>> = {
  SESSION_SCRIPT_SUPERSEDED:
    'This plan was replaced by a newer version while you were editing, so nothing was saved. Reload the list and edit the current version.',
  SESSION_SCRIPT_NOT_FOUND: 'This plan could not be found, so nothing was saved.',
  SESSION_SCRIPT_BLOCK_MINUTES_INVALID:
    'Nothing was saved. Each block needs whole minutes from the start of the session, with its end after its start.',
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
}: {
  readonly script: SessionScriptWithDetail;
  readonly onSaved: (outcome: SessionScriptEditOutcome, saved: SessionScriptWithDetail) => void;
  readonly onCancel: () => void;
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
    if (name.trim() === '') {
      setError('The plan needs a name.');
      return;
    }
    const edits = [];
    for (const [index, block] of blocks.entries()) {
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
      edits.push({ block_id: block.block_id, block_label: block.label, start_offset_min: start, end_offset_min: end });
    }

    inFlight.current = true;
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script_id: script.script_id, name, blocks: edits }),
        });
      } catch {
        setError('Network error. The plan may or may not have been saved -- reload the list to see which.');
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as {
        outcome?: SessionScriptEditOutcome;
        script?: SessionScriptWithDetail | null;
        error?: string;
      };
      if (response.ok && payload.outcome && payload.script) {
        onSaved(payload.outcome, payload.script);
        return;
      }
      setError(REFUSALS[payload.error ?? ''] ?? 'The plan could not be saved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
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
        <input className="input" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
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
                  className="input"
                  value={block.label}
                  maxLength={200}
                  onChange={(event) => change(block.block_id, 'label', event.target.value)}
                />
              </label>
              <label className="field w-[8rem]">
                <span className="t-label">Starts at minute</span>
                <input
                  className="input"
                  inputMode="numeric"
                  value={block.start}
                  onChange={(event) => change(block.block_id, 'start', event.target.value)}
                />
              </label>
              <label className="field w-[8rem]">
                <span className="t-label">Ends at minute</span>
                <input
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
        <p role="alert" className="rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[var(--locked-ink)]">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-[var(--s3)]">
        <button type="submit" disabled={busy} className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? 'Saving...' : 'Save plan'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60">
          Cancel
        </button>
      </div>
    </form>
  );
}
