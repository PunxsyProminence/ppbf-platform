'use client';

import { useEffect, useRef, useState } from 'react';

import { blockKindWord } from '@/components/blockKindIcons';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';

// Writing a text block (SP-2b): kind, title, what to say and contact level, for
// the editor's add_blocks (kind 'text'). THE CONTACT LEVEL IS THE COACH'S PICK,
// REQUIRED, NO DEFAULT (App Overwatch Q1 = C): the select starts empty and the
// block is not added until a rung is chosen. Ladder: the server's own list
// (VOCABULARIES.contact_level is sessionScriptAuthoring.ts CONTACT_LADDER), in
// drillPresentation.ts's words. Kinds: the migration's less drill_round, in
// blockKindIcons.tsx's words. Not a <form> (it sits in the editor's): Enter in the
// title adds the block instead of saving the plan. Nothing is added while the
// editor saves (`disabled`): it would miss the save.

export interface WrittenBlock {
  block_kind: string;
  block_label: string;
  text: string;
  contact_level: string;
}

const KINDS = VOCABULARIES.block_kind.values.filter((kind) => kind !== 'drill_round');
const CONTACT_LADDER = VOCABULARIES.contact_level.values;

/** The kinds the table lets hold no words (sessionScriptAuthoring.ts MAY_HOLD_NO_TEXT, pilot_ssb_content). */
const MAY_HOLD_NO_TEXT: readonly string[] = ['transition', 'arrival', 'close'];
/** The server's cap on a text block's words (sessionScriptAuthoring.ts MAX_BLOCK_TEXT_LENGTH). */
const MAX_TEXT_LENGTH = 1000;

export default function TextBlockForm({
  onAdd,
  onClose,
  disabled = false,
}: {
  readonly onAdd: (block: WrittenBlock) => void;
  readonly onClose: () => void;
  readonly disabled?: boolean;
}) {
  const [kind, setKind] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const add = () => {
    if (disabled) return;
    const found = [
      kind === '' ? 'Choose the kind of block.' : '',
      title.trim() === '' ? 'The block needs a title.' : '',
      // A plain trim: words the eye cannot see are the server's to refuse (cleanAdd), and it is the gate.
      kind !== '' && !MAY_HOLD_NO_TEXT.includes(kind) && text.trim() === ''
        ? 'Write what to say in this block. Only Arrival, Transition and Close blocks can be left without words.'
        : '',
      text.length > MAX_TEXT_LENGTH ? `What to say can be ${MAX_TEXT_LENGTH} characters at most.` : '',
      contact === '' ? 'Choose the contact level. A text block has none until you choose one.' : '',
    ].filter(Boolean);
    setProblems(found);
    if (found.length === 0) onAdd({ block_kind: kind, block_label: title, text, contact_level: contact });
  };

  const field = 'input--kiosk min-h-[var(--tap)] text-[length:var(--t-md)]';
  const button = 'btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-md)]';

  return (
    <section
      aria-label="Write a text block"
      className="flex flex-col gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      <label className="field">
        <span className="t-label">Kind of block</span>
        <select ref={first} className={`select ${field}`} value={kind} aria-required="true" onChange={(event) => setKind(event.target.value)}>
          <option value="">Choose the kind of block</option>
          {KINDS.map((value) => <option key={value} value={value}>{blockKindWord(value) ?? value}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="t-label">Title</span>
        <input
          type="text"
          className={`input ${field}`}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
        />
      </label>
      <label className="field">
        <span className="t-label">What to say</span>
        <textarea className={`textarea ${field}`} rows={4} maxLength={MAX_TEXT_LENGTH} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <label className="field">
        <span className="t-label">Contact level</span>
        <select className={`select ${field}`} value={contact} aria-required="true" onChange={(event) => setContact(event.target.value)}>
          <option value="">Choose the contact level</option>
          {CONTACT_LADDER.map((value) => <option key={value} value={value}>{humanizeContactLevel(value)}</option>)}
        </select>
      </label>
      {problems.length > 0 && (
        <p role="alert" className="text-[length:var(--t-md)] font-semibold">
          Not added yet. {problems.join(' ')}
        </p>
      )}
      <div className="flex flex-wrap gap-[var(--s3)]">
        <button type="button" className={`${button} disabled:cursor-not-allowed disabled:opacity-60`} disabled={disabled} onClick={add}>
          Add this block
        </button>
        <button type="button" className={button} onClick={onClose}>
          Close without adding
        </button>
      </div>
    </section>
  );
}
