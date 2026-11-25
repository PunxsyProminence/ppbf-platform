'use client';

import { useEffect, useRef, useState } from 'react';

import BlockDrillPicker, { type PickableDrill } from './BlockDrillPicker';
import CopyBlockPicker, { type CopiedBlock } from './CopyBlockPicker';
import TextBlockForm, { INVISIBLE, type WrittenBlock } from './TextBlockForm';

import { blockKindWord } from '@/components/blockKindIcons';
import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel, NOT_WRITTEN_YET } from '@/src/lib/drillPresentation';
import type { SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';

// Changing a plan: its name, each block's title and minutes (lane L1), and
// (SP-2a) adding a block from the drill library, removing a block, and moving a
// block up or down, and (SP-2b) writing a text block or copying a block of any
// of the gym's plans, all in this form and this one Save.
//
// The minutes stay what the page shows everywhere else: minutes from the start
// of the session, a start and an end, never a clock time. After an add, a remove
// or a move the blocks from the change point on are re-timed to run on (runOn
// below; App Overwatch ruling Q2 = A), in the form, before Save; every minute can
// still be edited. A drill block's contact level is its drill's own, set by the
// server; a copy's is its source's; a text block's is the coach's pick in its
// form, required, with no default (TextBlockForm.tsx; App Overwatch Q1 = C).
//
// ONLY WHAT WAS CHANGED IS SENT. The name goes only if it was retyped, and a
// kept block only if its title or minutes were; the server keeps the rest. A new
// block goes in add_blocks, a removed one in remove_block_ids, and `order` is
// sent only when the running order changed. So a
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
/** Why a new version was made: the plan had been run, or a block was removed. */
export type SessionScriptEditBecause = 'run' | 'removal';

interface BlockDraft {
  /** A stored block's id; for a new block, the client-side ref sent in add_blocks and order. */
  block_id: string;
  label: string;
  start: string;
  end: string;
  /** Present only on a block added here and not saved yet. */
  added?:
    | { kind: 'drill'; drill_id: string; drill_name: string }
    | ({ kind: 'text' } & Omit<WrittenBlock, 'block_label'>)
    | ({ kind: 'copy' } & CopiedBlock);
}

// A new block is this long: the server's DEFAULT_STEP_MINUTES
// (sessionScriptAuthoring.ts). Local because that module is server-only.
const NEW_BLOCK_MINUTES = 5;

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
  // Not "nothing of yours": the earlier save may be this coach's own try whose answer was lost
  // (the plan page's retire words say the same; SP-2b reviewer G).
  SESSION_SCRIPT_CHANGED:
    'This plan was saved after you opened it: on another screen, by another coach, or by an earlier try of yours whose answer was lost. This try was not saved, and that save is as it was left. Open the plan again to see it, then make any changes still needed.',
  SESSION_SCRIPT_SUPERSEDED:
    'This plan has been replaced by a newer version, which may hold an earlier try of yours whose answer was lost. This try was not saved. Reload the list and edit the current version.',
  SESSION_SCRIPT_NOT_FOUND: 'This plan could not be found, so nothing was saved.',
  SESSION_SCRIPT_BLOCK_MINUTES_INVALID:
    `Nothing was saved. Each block needs whole minutes from the start of the session, its end after its start and no later than minute ${LAST_MINUTE}.`,
  SESSION_SCRIPT_BLOCK_LABEL_INVALID: 'Nothing was saved. Every block needs a title of 200 characters or fewer.',
  SESSION_SCRIPT_NAME_INVALID: 'Nothing was saved. The plan needs a name of 200 characters or fewer.',
  SESSION_SCRIPT_ORDER_INVALID:
    'Nothing was saved. The running order of the blocks was not accepted. Open the plan again and make your changes again.',
  SESSION_SCRIPT_BLOCK_REPEATED:
    'Nothing was saved. A block was named twice in one save. Open the plan again and make your changes again.',
  SESSION_SCRIPT_BLOCK_REF_INVALID:
    'Nothing was saved. A block you added was not accepted. Remove it, add it again and save again.',
  SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT:
    'Nothing was saved. A block you changed or removed is not in this plan any more. Open the plan again to see it as it is now.',
  SESSION_SCRIPT_DRILL_NOT_FOUND:
    'Nothing was saved. A drill you added is not one of this gym\'s drills. Remove that block and choose a drill from the library.',
  // Also a copied block whose drill has no current version (sessionScriptAuthoring.ts copyHeads, lockDrills):
  // copying it again fails the same way, so the advice is the library, which lists only current drills.
  SESSION_SCRIPT_DRILL_NOT_CURRENT:
    'Nothing was saved. A drill you added, or the drill of a block you copied, has been replaced or withdrawn. Remove that block, then choose a drill from the drill library, which lists only current drills.',
  SESSION_SCRIPT_BLOCK_KIND_INVALID:
    'Nothing was saved. A text block you wrote has a kind of block that was not accepted. Remove it and write it again.',
  // A text block's level, or a copied block's own (its source holds a level not on the ladder).
  SESSION_SCRIPT_BLOCK_CONTACT_INVALID:
    'Nothing was saved. A block you wrote or copied does not have a contact level from the contact ladder. Remove that block, then write a text block and choose its contact level, or add a drill from the library.',
  SESSION_SCRIPT_BLOCK_TEXT_INVALID:
    'Nothing was saved. The words of a text block you wrote were not accepted: every kind but Arrival, Transition and Close needs words, and they can be 1000 characters at most. Remove it and write it again.',
  SESSION_SCRIPT_COPY_SOURCE_NOT_FOUND:
    'Nothing was saved. A block you copied could not be found in this gym\'s plans. Remove that block and copy one from the plans again.',
  SESSION_SCRIPT_COPY_CONTACT_ABOVE_DRILL:
    'Nothing was saved. A block you copied runs at more contact than its drill now allows: the gym has lowered that drill\'s contact level. Remove that block, or add the drill from the library, which carries its new level.',
};

/** What a block added here is, in words: a drill, a block the coach wrote, or a copy, with its kind and contact level. */
function newWords(added: NonNullable<BlockDraft['added']>): string {
  if (added.kind === 'drill') return `drill ${added.drill_name}`;
  const kind = blockKindWord(added.block_kind) ?? added.block_kind;
  const contact = humanizeContactLevel(added.contact_level);
  return added.kind === 'text'
    ? `${kind} block you wrote (${contact})`
    : `copy of ${added.block_label || 'a block with no title'} from ${added.plan_name} (${kind}, ${contact})`;
}

/** A text block's words as the editor shows them: words the eye cannot see are no words (as the server reads them). */
function writtenWords(text: string): string {
  return text.replace(INVISIBLE, '').trim() === '' ? NOT_WRITTEN_YET : text.trim();
}

const TEXT_FORM_OPEN = 'Add the text block you are writing, or close its form, before you save.';

/**
 * A title as the server will store it: trimmed and at most 200 UTF-16 units (cleanText counts
 * .length), never ending in half a surrogate pair. A block added here starts with this title, so the
 * title the coach sees is the title stored (Codex on #2203; reviewers F and G).
 */
export function storedTitle(text: string): string {
  const cut = text.trim().slice(0, 200);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

function wholeMinutes(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * Re-times the blocks from `from` on so each starts where the block before it
 * ends, keeping each block's own length (end - start). Blocks before `from` are
 * untouched; the block at index 0 starts at `firstStart` (null: it was not a
 * whole number, so nothing from the change on is re-timed). A block whose minutes
 * are not whole or whose end is not after its start is left as typed (the save
 * names it), and the run continues from its end when that can be read.
 */
export function runOn<T extends { start: string; end: string }>(blocks: readonly T[], from: number, firstStart: number | null = 0): T[] {
  const out = blocks.slice();
  let cursor: number | null = from <= 0 ? firstStart : wholeMinutes(out[from - 1].end);
  for (let index = Math.max(from, 0); index < out.length && cursor !== null; index += 1) {
    const start = wholeMinutes(out[index].start);
    const end = wholeMinutes(out[index].end);
    if (start === null || end === null || end <= start) {
      cursor = end;
      continue;
    }
    cursor += end - start;
    out[index] = { ...out[index], start: String(cursor - (end - start)), end: String(cursor) };
  }
  return out;
}

export default function SessionScriptEditor({
  script,
  onSaved,
  onCancel,
  onBusyChange,
}: {
  readonly script: SessionScriptWithDetail;
  /** `saved` is null when the server saved but its answer could not be read. */
  readonly onSaved: (
    outcome: SessionScriptEditOutcome | null,
    saved: SessionScriptWithDetail | null,
    because?: SessionScriptEditBecause,
  ) => void;
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
  // Which way of adding a block is open, if any; each closes back to the button that opened it.
  const [panel, setPanel] = useState<null | 'add' | 'text' | 'copy'>(null);
  const refCount = useRef(0);
  // One save per press: `busy` disables the button only after a render.
  const inFlight = useRef(false);

  // While a save is in flight its body is already sent, so a late edit would be lost when the
  // editor closes: the fields are read-only then, and a change is not taken (Codex on #2199).
  const change = (blockId: string, field: 'label' | 'start' | 'end', value: string) => {
    if (inFlight.current) return;
    setBlocks((current) => current.map((block) => (block.block_id === blockId ? { ...block, [field]: value } : block)));
  };

  // Keyboard focus: a button that was pressed can become disabled or leave the
  // page, so the handlers name where focus goes and it is moved once the new
  // rows are on screen.
  const [focusables] = useState(() => new Map<string, HTMLElement>());
  const wantFocus = useRef<string | null>(null);
  const hold = (key: string) => (element: HTMLElement | null) => {
    if (element) focusables.set(key, element);
    else focusables.delete(key);
  };
  useEffect(() => {
    const key = wantFocus.current;
    wantFocus.current = null;
    if (!key) return;
    // A target that is not on screen, or is disabled while saving, falls back to the plan name,
    // so focus never drops to the page (reviewers E and F).
    const target = focusables.get(key);
    (target && !(target as HTMLButtonElement).disabled ? target : focusables.get('name'))?.focus();
  });

  // Where the first block starts now, so a move or a remove at the top keeps it;
  // null when it is not a whole number, and then those minutes are left as typed.
  const firstStart = () => (blocks.length > 0 ? wholeMinutes(blocks[0].start) : 0);

  const remove = (index: number) => {
    const rest = blocks.filter((_, at) => at !== index);
    const neighbour = rest[index] ?? rest[index - 1];
    wantFocus.current = neighbour ? `${neighbour.block_id}:remove` : 'add';
    setBlocks(runOn(rest, index, firstStart()));
  };

  const move = (index: number, by: -1 | 1) => {
    const next = blocks.slice();
    [next[index], next[index + by]] = [next[index + by], next[index]];
    // The same button, unless the block is now at the end that button points to.
    const now = index + by;
    const sameDisabled = by === -1 ? now === 0 : now === next.length - 1;
    wantFocus.current = `${blocks[index].block_id}:${(by === -1) !== sameDisabled ? 'up' : 'down'}`;
    setBlocks(runOn(next, Math.min(index, now), firstStart()));
  };

  // A new block goes last, starting where the last block ends.
  const add = (label: string, added: NonNullable<BlockDraft['added']>) => {
    const taken = new Set(script.blocks.map((block) => block.block_id));
    let ref: string;
    do {
      refCount.current += 1;
      ref = `new-block-${refCount.current}`;
    } while (taken.has(ref));
    const last = blocks[blocks.length - 1];
    const start = last ? wholeMinutes(last.end) : 0;
    setBlocks([
      ...blocks,
      {
        block_id: ref,
        label,
        start: start === null ? '' : String(start),
        end: start === null ? '' : String(start + NEW_BLOCK_MINUTES),
        added,
      },
    ]);
    wantFocus.current = `${ref}:title`;
    setPanel(null);
  };
  // The name as the server would store it; when that is not the name itself, block_label is sent.
  const addDrill = (drill: PickableDrill) => add(storedTitle(drill.name), { kind: 'drill', drill_id: drill.drill_id, drill_name: drill.name });
  const addText = ({ block_label, ...written }: WrittenBlock) => {
    setError((shown) => (shown === TEXT_FORM_OPEN ? '' : shown));
    add(block_label, { kind: 'text', ...written });
  };
  // The title the coach sees is the title sent (reviewer G): the source's as it was read, as the server
  // would store it (storedTitle), so a later rename of the source cannot change it at save.
  const addCopy = (copied: CopiedBlock) => {
    const title = storedTitle(copied.block_label);
    add(title, { kind: 'copy', ...copied, block_label: title });
  };

  const closePanel = () => {
    setError((shown) => (shown === TEXT_FORM_OPEN ? '' : shown));
    wantFocus.current = panel;
    setPanel(null);
  };

  const save = async () => {
    if (inFlight.current) return;
    setError('');

    // Said here, by block, before anything is sent; the server checks the same things.
    if (panel === 'text') {
      setError(TEXT_FORM_OPEN);
      return;
    }
    const nameChanged = name !== script.name;
    if (nameChanged && name.trim() === '') {
      setError('The plan needs a name.');
      return;
    }
    const edits = [];
    const additions = [];
    const storedById = new Map(script.blocks.map((stored) => [stored.block_id, stored]));
    for (const [index, block] of blocks.entries()) {
      const stored = storedById.get(block.block_id);
      if (
        stored
        && block.label === stored.block_label
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
      const { added } = block;
      const place = { start_offset_min: start, end_offset_min: end };
      if (added?.kind === 'drill') {
        additions.push({
          ref: block.block_id,
          kind: 'drill',
          drill_id: added.drill_id,
          // Left out when it is the drill's name: the server's own title then stands.
          ...(block.label !== added.drill_name ? { block_label: block.label } : {}),
          ...place,
        });
      } else if (added?.kind === 'text') {
        const { block_kind, text, contact_level } = added;
        additions.push({ ref: block.block_id, kind: 'text', block_kind, block_label: block.label, text, contact_level, ...place });
      } else if (added?.kind === 'copy') {
        // Always the title shown, so the source's title at save time cannot replace it (reviewer G).
        additions.push({ ref: block.block_id, kind: 'copy', block_id: added.block_id, block_label: block.label, ...place });
      } else {
        edits.push({ block_id: block.block_id, block_label: block.label, start_offset_min: start, end_offset_min: end });
      }
    }
    const keptIds = new Set(blocks.map((block) => block.block_id));
    const removed = script.blocks.filter((stored) => !keptIds.has(stored.block_id)).map((stored) => stored.block_id);
    // Without `order` the server keeps the kept blocks' order and puts new ones last.
    const defaultOrder = [
      ...script.blocks.filter((stored) => keptIds.has(stored.block_id)).map((stored) => stored.block_id),
      ...blocks.filter((block) => block.added).map((block) => block.block_id),
    ];
    const order = blocks.map((block) => block.block_id);
    const orderChanged = order.some((id, at) => id !== defaultOrder[at]);

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
            ...(additions.length > 0 ? { add_blocks: additions } : {}),
            ...(removed.length > 0 ? { remove_block_ids: removed } : {}),
            ...(orderChanged ? { order } : {}),
          }),
        });
      } catch {
        setError('No answer arrived, so it is not known whether the plan was saved. Reload the list to see which.');
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        outcome?: SessionScriptEditOutcome;
        because?: SessionScriptEditBecause;
        script?: SessionScriptWithDetail | null;
        error?: unknown;
      } | null;
      if (response.ok) {
        if (payload?.outcome !== undefined && payload.script) {
          if (payload.because) onSaved(payload.outcome, payload.script, payload.because);
          else onSaved(payload.outcome, payload.script);
        } else onSaved(null, null);
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

  const rowButton = 'btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60';

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
        <input ref={hold('name')} type="text" className="input" value={name} maxLength={200} readOnly={busy} onChange={(event) => { if (!inFlight.current) setName(event.target.value); }} />
      </label>

      <ol aria-label="Blocks to edit, in the order they run" className="flex flex-col gap-[var(--s3)]">
        {blocks.map((block, index) => (
          <li
            key={block.block_id}
            className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
          >
            <fieldset className="flex flex-wrap items-end gap-[var(--s3)]">
              <legend className="t-label">Block {index + 1}</legend>
              {block.added && (
                <p className="w-full text-[length:var(--t-md)] font-semibold">
                  New, not saved yet: {newWords(block.added)}
                </p>
              )}
              {block.added?.kind === 'text' && (
                <p className="w-full whitespace-pre-wrap text-[length:var(--t-md)]">What to say: {writtenWords(block.added.text)}</p>
              )}
              <label className="field min-w-[14rem] flex-1">
                <span className="t-label">Title</span>
                <input
                  ref={hold(`${block.block_id}:title`)}
                  type="text"
                  className="input"
                  value={block.label}
                  maxLength={200}
                  readOnly={busy}
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
                  readOnly={busy}
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
                  readOnly={busy}
                  onChange={(event) => change(block.block_id, 'end', event.target.value)}
                />
              </label>
              <div className="flex w-full flex-wrap gap-[var(--s3)]">
                <button type="button" ref={hold(`${block.block_id}:up`)} disabled={busy || index === 0} aria-label={`Move up, block ${index + 1}`} onClick={() => move(index, -1)} className={rowButton}>
                  Move up
                </button>
                <button type="button" ref={hold(`${block.block_id}:down`)} disabled={busy || index === blocks.length - 1} aria-label={`Move down, block ${index + 1}`} onClick={() => move(index, 1)} className={rowButton}>
                  Move down
                </button>
                <button type="button" ref={hold(`${block.block_id}:remove`)} disabled={busy} aria-label={`Remove, block ${index + 1}`} onClick={() => remove(index)} className={rowButton}>
                  Remove
                </button>
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      {blocks.length === 0 && (
        <p className="text-[length:var(--t-md)]">This plan has no blocks. Add a drill from the library, write a text block or copy a block.</p>
      )}

      {panel === 'add' && <BlockDrillPicker disabled={busy} onPick={addDrill} onClose={closePanel} />}
      {panel === 'text' && <TextBlockForm onAdd={addText} onClose={closePanel} disabled={busy} />}
      {panel === 'copy' && <CopyBlockPicker currentScriptId={script.script_id} onPick={addCopy} onClose={closePanel} disabled={busy} />}
      {panel === null && (
        <div className="flex flex-wrap gap-[var(--s3)]">
          <button type="button" ref={hold('add')} disabled={busy} onClick={() => setPanel('add')} className={rowButton}>
            Add a drill from the library
          </button>
          <button type="button" ref={hold('text')} disabled={busy} onClick={() => setPanel('text')} className={rowButton}>
            Write a text block
          </button>
          <button type="button" ref={hold('copy')} disabled={busy} onClick={() => setPanel('copy')} className={rowButton}>
            Copy a block from a plan
          </button>
        </div>
      )}

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
