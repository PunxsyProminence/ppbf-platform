import TutorialButton from '@/components/TutorialButton';
import type { MasterTutorialCard } from '@/components/helpContent';

interface TutorialCardProps {
  readonly card: MasterTutorialCard;
}

export default function TutorialCard({ card }: TutorialCardProps) {
  const anchor = card.href.includes('#') ? card.href.split('#')[1] : undefined;

  return (
    <article className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] p-4">
      <h3 className="text-base font-black text-[var(--black)]">{card.title}</h3>
      <div className="mt-3 space-y-2 text-sm leading-6 text-[var(--gray-dark)]">
        <p><span className="font-bold text-[var(--black)]">Purpose:</span> {card.purpose}</p>
        <p><span className="font-bold text-[var(--black)]">Who uses it:</span> {card.whoUsesIt}</p>
        <p><span className="font-bold text-[var(--black)]">Current status:</span> {card.currentStatus}</p>
      </div>
      <div className="mt-4">
        <TutorialButton anchor={anchor} label="Open Tutorial" />
      </div>
    </article>
  );
}
