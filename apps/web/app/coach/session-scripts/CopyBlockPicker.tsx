'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { blockKindWord } from '@/components/blockKindIcons';
import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import type { SessionScriptBlockRow, SessionScriptRow } from '@/src/server/pilot/sessionScripts';

// Choosing a block of one of the gym's plans to copy (SP-2b). GET
// /api/pilot/session-scripts lists the plans at their current versions (retired
// left out), this plan included; GET ?script_id= answers the one opened with its
// blocks. Loading, could not be loaded and empty are said in words; a failed read
// never shows as a list. A copy carries its source's kind and contact level, so
// both are shown beside each block. Focus goes into the picker when it opens;
// nothing is chosen while the editor saves (`disabled`): it would miss the save.
// No field here takes typing, so Enter never submits the editor's form.

export interface CopiedBlock {
  block_id: string;
  block_label: string;
  block_kind: string;
  contact_level: string;
  plan_name: string;
}

type Plan = Pick<SessionScriptRow, 'script_id' | 'name'>;
type SourceBlock = Pick<SessionScriptBlockRow, 'block_id' | 'block_label' | 'block_kind' | 'contact_level'>;
type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; value: T[] };

/** Reads `url`; `pick` takes the list out of the body, or null when it is not there. Returns the effect's cleanup. */
function read<T>(url: string, pick: (body: Record<string, unknown> | null) => unknown, settle: (load: Load<T>) => void) {
  let current = true;
  void (async () => {
    try {
      const response = await fetch(url, { credentials: 'include' });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!current) return;
      const list = response.ok ? pick(body) : null;
      settle(Array.isArray(list) ? { state: 'ready', value: list as T[] } : { state: 'failed' });
    } catch {
      if (current) settle({ state: 'failed' });
    }
  })();
  return () => {
    current = false;
  };
}

function Failed({ sentence, onRetry }: { readonly sentence: string; readonly onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-[var(--s3)]">
      <p role="alert" className="text-[length:var(--t-md)] font-semibold">{sentence} Try again.</p>
      <button type="button" className="btn min-h-[var(--tap)] text-[length:var(--t-md)]" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default function CopyBlockPicker({
  currentScriptId,
  onPick,
  onClose,
  disabled = false,
}: {
  readonly currentScriptId: string;
  readonly onPick: (block: CopiedBlock) => void;
  readonly onClose: () => void;
  readonly disabled?: boolean;
}) {
  const [plans, setPlans] = useState<Load<Plan>>({ state: 'loading' });
  const [plansAttempt, setPlansAttempt] = useState(0);
  const [opened, setOpened] = useState<Plan | null>(null);
  const [blocks, setBlocks] = useState<Load<SourceBlock>>({ state: 'loading' });
  const [blocksAttempt, setBlocksAttempt] = useState(0);

  // Focus moves with the view: into the picker when it opens, to Back when a plan opens, to that plan's button on Back.
  const [focusables] = useState(() => new Map<string, HTMLElement>());
  const wantFocus = useRef<string | null>('picker');
  const hold = (key: string) => (element: HTMLElement | null) => {
    if (element) focusables.set(key, element);
    else focusables.delete(key);
  };
  useEffect(() => {
    const key = wantFocus.current;
    wantFocus.current = null;
    if (key) focusables.get(key)?.focus();
  });

  useEffect(() => read<Plan>(`${apiBase()}/api/pilot/session-scripts`, (body) => body?.scripts, setPlans), [plansAttempt]);
  useEffect(() => {
    if (!opened) return undefined;
    const url = `${apiBase()}/api/pilot/session-scripts?script_id=${encodeURIComponent(opened.script_id)}`;
    return read<SourceBlock>(url, (body) => (body?.script as { blocks?: unknown } | undefined)?.blocks, setBlocks);
  }, [opened, blocksAttempt]);

  const open = (plan: Plan) => {
    setBlocks({ state: 'loading' });
    setOpened(plan);
    wantFocus.current = 'back';
  };
  const back = () => {
    wantFocus.current = `plan:${opened?.script_id}`;
    setOpened(null);
  };

  const button = 'btn min-h-[var(--tap)] text-[length:var(--t-md)]';
  const choice = `${button} btn--ghost w-full justify-start text-left`;
  const words = 'text-[length:var(--t-md)]';

  let body: ReactNode;
  if (opened === null) {
    body = plans.state === 'loading' ? (
      <p role="status" className={words}>Loading the gym&apos;s plans…</p>
    ) : plans.state === 'failed' ? (
      <Failed
        sentence="The gym's plans could not be loaded, so no plans are shown."
        onRetry={() => {
          wantFocus.current = 'close';
          setPlans({ state: 'loading' });
          setPlansAttempt((count) => count + 1);
        }}
      />
    ) : plans.value.length === 0 ? (
      <p className={words}>The gym has no plans to copy a block from.</p>
    ) : (
      <ul aria-label="The gym's plans" className="flex max-h-[24rem] flex-col gap-[var(--s2)] overflow-y-auto">
        {plans.value.map((plan) => (
          <li key={plan.script_id}>
            <button type="button" ref={hold(`plan:${plan.script_id}`)} className={choice} onClick={() => open(plan)}>
              {plan.name}
              {plan.script_id === currentScriptId ? ' (this plan)' : ''}
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <>
        <p className={`${words} font-semibold`}>Blocks of {opened.name}</p>
        {blocks.state === 'loading' && <p role="status" className={words}>Loading the blocks of {opened.name}…</p>}
        {blocks.state === 'failed' && (
          <Failed
            sentence={`The blocks of ${opened.name} could not be loaded, so none are shown.`}
            onRetry={() => {
              wantFocus.current = 'back';
              setBlocks({ state: 'loading' });
              setBlocksAttempt((count) => count + 1);
            }}
          />
        )}
        {blocks.state === 'ready' && blocks.value.length === 0 && <p className={words}>{opened.name} has no blocks to copy.</p>}
        {blocks.state === 'ready' && blocks.value.length > 0 && (
          <ul aria-label={`Blocks of ${opened.name}`} className="flex max-h-[24rem] flex-col gap-[var(--s2)] overflow-y-auto">
            {blocks.value.map((block) => (
              <li key={block.block_id}>
                <button
                  type="button"
                  className={`${choice} disabled:cursor-not-allowed disabled:opacity-60`}
                  disabled={disabled}
                  onClick={() => {
                    const { block_id, block_label, block_kind, contact_level } = block;
                    onPick({ block_id, block_label, block_kind, contact_level, plan_name: opened.name });
                  }}
                >
                  {block.block_label.trim() || 'No title'} ({blockKindWord(block.block_kind) ?? block.block_kind}, {humanizeContactLevel(block.contact_level)})
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button type="button" ref={hold('back')} className={`${button} btn--ghost`} onClick={back}>
            Back to the list of plans
          </button>
        </div>
      </>
    );
  }

  return (
    <section
      ref={hold('picker')}
      tabIndex={-1}
      aria-label="Copy a block from a plan"
      className="flex flex-col gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      {body}
      <div>
        <button type="button" ref={hold('close')} className={`${button} btn--ghost`} onClick={onClose}>
          Close without copying
        </button>
      </div>
    </section>
  );
}
