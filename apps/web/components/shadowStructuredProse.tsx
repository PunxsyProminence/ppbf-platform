import type { ReactNode } from 'react';

/**
 * SHADOW answers arrive as one flat string (`response`), and the server's
 * safety validator inspects exactly that string -- so structure here is
 * DERIVED for display, never a replacement for the canonical text. When the
 * chat contract later grows an additive `sections` field, this renderer is
 * the fallback for every message that predates it (stored rows, error
 * envelopes, queued placeholders, the client-built welcome).
 *
 * The split is deliberately conservative: blank-line paragraphs, and runs of
 * bullet ("-", "*", "•") or numbered ("1.", "2)") lines become real lists.
 * Nothing else is guessed at -- no heading inference, no italics -- because a
 * wrong guess about a safety sentence is worse than a plain paragraph. The one
 * mark that is read is a balanced **bold** pair: the words inside are printed
 * exactly as they were and only their weight changes, so reading it cannot
 * change what a sentence says; the athlete used to see the asterisks (F-053).
 * An unmatched ** is left as typed. Everything renders as React text nodes;
 * there is no HTML path, so model output can never inject markup.
 */

const BULLET_PATTERN = /^\s*[-*•]\s+/;
const NUMBERED_PATTERN = /^\s*\d{1,3}[.)]\s+/;

export type ProseBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbered'; items: string[] };

/** Exported for tests: the pure split, no React. */
export function splitProseBlocks(raw: string): ProseBlock[] {
  const text = raw.replace(/\r\n/g, '\n');
  const blocks: ProseBlock[] = [];

  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (BULLET_PATTERN.test(line)) {
        const items: string[] = [];
        while (index < lines.length && BULLET_PATTERN.test(lines[index])) {
          items.push(lines[index].replace(BULLET_PATTERN, ''));
          index += 1;
        }
        blocks.push({ kind: 'bullets', items });
        continue;
      }
      if (NUMBERED_PATTERN.test(line)) {
        const items: string[] = [];
        while (index < lines.length && NUMBERED_PATTERN.test(lines[index])) {
          items.push(lines[index].replace(NUMBERED_PATTERN, ''));
          index += 1;
        }
        blocks.push({ kind: 'numbered', items });
        continue;
      }
      // Consecutive plain lines inside one chunk are a single paragraph a
      // model wrapped by hand; join them the way the old single-<p> renderer
      // effectively did, but only within the chunk.
      const paragraphLines: string[] = [];
      while (
        index < lines.length
        && !BULLET_PATTERN.test(lines[index])
        && !NUMBERED_PATTERN.test(lines[index])
      ) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') });
    }
  }

  return blocks;
}

// A bold pair is a **word or phrase** standing on its own, as a person writes
// it: the words inside start and end on something that is not a space or a
// star, and the pair is not stuck to a letter or digit on either side. So
// "x ** 2 + y ** 2" and "x**2 + y**2" are arithmetic and are left alone, and
// "**jab**," or "(**guard**)" are bold. Group 1 is the one character before the
// opening pair (or nothing at the start), kept as plain text. No lookbehind:
// the gym tablets are not all on a browser that parses one.
const BOLD_PAIR = /(^|[^\p{L}\p{N}*])\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*(?![\p{L}\p{N}*])/gu;

/** Exported for tests: text with each balanced **pair** as a <strong> text node. */
export function renderInlineBold(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD_PAIR)) {
    const start = match.index ?? 0;
    const boldStart = start + match[1].length;
    if (boldStart > last) nodes.push(text.slice(last, boldStart));
    nodes.push(<strong key={`bold-${boldStart}`}>{match[2]}</strong>);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface ShadowStructuredProseProps {
  readonly text: string;
  /**
   * Class applied to the wrapper. The caller owns colour (inherited from the
   * bubble) -- this component names no design tokens so the legacy-vocabulary
   * ceilings are untouched by it.
   */
  readonly className?: string;
}

export default function ShadowStructuredProse({ text, className }: ShadowStructuredProseProps): ReactNode {
  const blocks = splitProseBlocks(text);
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        const key = `${block.kind}-${blockIndex}`;
        if (block.kind === 'paragraph') {
          return <p key={key}>{renderInlineBold(block.text)}</p>;
        }
        const items = block.items.map((item, itemIndex) => (
          <li key={`${key}-item-${itemIndex}`}>{renderInlineBold(item)}</li>
        ));
        return block.kind === 'bullets'
          ? <ul key={key} className="list-disc pl-[var(--s5)]">{items}</ul>
          : <ol key={key} className="list-decimal pl-[var(--s5)]">{items}</ol>;
      })}
    </div>
  );
}
