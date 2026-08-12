'use client';

import { useState } from 'react';

export interface DrillTaxonomy {
  'Level 01: Core Direct Cue': string;
  'Level 02: Field Instruction Architecture': string;
  'Level 03: Psycho-Physiological Mapping': string;
  'Level 04: Biomechanical Evidence Anchor': string;
  'Level 05: Lab Genesis & Sources': string;
  'Level 06: Historical Chronology Genesis (Who, What, Where, When)': string;
}

interface DrillLibraryAccordionProps {
  drill: DrillTaxonomy;
}

type TierKey = keyof DrillTaxonomy;

const TIER_KEYS: TierKey[] = [
  'Level 01: Core Direct Cue',
  'Level 02: Field Instruction Architecture',
  'Level 03: Psycho-Physiological Mapping',
  'Level 04: Biomechanical Evidence Anchor',
  'Level 05: Lab Genesis & Sources',
  'Level 06: Historical Chronology Genesis (Who, What, Where, When)',
];

export default function DrillLibraryAccordion({ drill }: DrillLibraryAccordionProps) {
  const [expanded, setExpanded] = useState<Record<TierKey, boolean>>({
    'Level 01: Core Direct Cue': false,
    'Level 02: Field Instruction Architecture': false,
    'Level 03: Psycho-Physiological Mapping': false,
    'Level 04: Biomechanical Evidence Anchor': false,
    'Level 05: Lab Genesis & Sources': false,
    'Level 06: Historical Chronology Genesis (Who, What, Where, When)': false,
  });
  const [seatedAdaptation, setSeatedAdaptation] = useState(false);

  const toggleTier = (key: TierKey) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <section className="bg-[#09090b] border border-zinc-800 rounded-none font-mono text-slate-300 p-2">
      <header className="border border-zinc-800 rounded-none p-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-slate-300 text-xs">L07 Drill Library: 6-Tier Deep Branching Taxonomy</h2>
          <span className="border border-zinc-800 rounded-none px-1 py-[2px] text-xs">[V-COACH]</span>
        </div>

        <button
          type="button"
          onClick={() => setSeatedAdaptation((value) => !value)}
          className="mt-2 w-full text-left border border-zinc-800 rounded-none bg-[#09090b] text-slate-300 px-2 py-1 text-[11px]"
        >
          [MECHANICAL SELECTION: STANDARD CONTACT // SEATED ACCESSIBILITY ADAPTATION]
        </button>

        {seatedAdaptation && (
          <p className="mt-2 border border-sky-600 rounded-none px-2 py-1 text-[11px] text-sky-200 bg-sky-950/80">
            WARNING: Seated Accessibility Adaptation is active for this drill view.
          </p>
        )}
      </header>

      <div className="mt-2 border border-zinc-800 rounded-none">
        {TIER_KEYS.map((tierKey) => {
          const isOpen = expanded[tierKey];
          const contentId = `tier-${tierKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

          return (
            <article key={tierKey} className="border-b border-zinc-800 last:border-b-0">
              <button
                type="button"
                className="w-full text-left bg-[#09090b] text-slate-300 font-mono px-2 py-2 rounded-none"
                aria-expanded={isOpen}
                aria-controls={contentId}
                onClick={() => toggleTier(tierKey)}
              >
                <span className="text-xs">{isOpen ? '[-] ' : '[+] '}{tierKey}</span>
              </button>

              {isOpen && (
                <div id={contentId} className="bg-[#09090b] border-t border-zinc-800 px-2 py-2 text-xs text-slate-300">
                  {drill[tierKey]}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
