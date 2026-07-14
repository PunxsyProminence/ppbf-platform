import Link from 'next/link';

interface TutorialButtonProps {
  readonly anchor?: string;
  readonly label?: string;
  readonly className?: string;
}

export default function TutorialButton({ anchor, label = 'HOW THIS WORKS', className }: TutorialButtonProps) {
  const href = anchor ? `/help#${anchor}` : '/help';

  return (
    <Link
      href={href}
      className={`inline-flex min-h-[40px] items-center justify-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 text-xs font-mono font-bold uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan-dark)] ${className ?? ''}`.trim()}
    >
      {label}
    </Link>
  );
}
