import ShadowChatButton from '@/components/ShadowChatButton';
import type { MasterTutorialCard } from '@/components/helpContent';

interface TutorialCardProps {
  readonly card: MasterTutorialCard;
}

export default function TutorialCard({ card }: TutorialCardProps) {
  return (
    <article className="border border-[color:color-mix(in_srgb,currentColor_26%,transparent)] p-4">
      <h3 className="text-base font-black">{card.title}</h3>
      <div className="mt-3 space-y-2 text-sm leading-6 opacity-80">
        <p><span className="font-bold">Purpose:</span> {card.purpose}</p>
        <p><span className="font-bold">Who uses it:</span> {card.whoUsesIt}</p>
        <p><span className="font-bold">Current status:</span> {card.currentStatus}</p>
      </div>
      <div className="mt-4">
        <ShadowChatButton context={card.title} label="Open SHADOW Chat" />
      </div>
    </article>
  );
}
