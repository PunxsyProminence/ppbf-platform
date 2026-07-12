export const ui = {
  tabContainer: 'border-2 border-[#8b4444] bg-[#0f0f0f]',
  tabRow: 'flex flex-wrap gap-1 p-2',
  tabButtonBase:
    'px-3 py-2 text-xs font-semibold uppercase transition border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4a574]',
  tabButtonActive: 'bg-[#5a2a2a] border-[#8b4444] text-[#e8d7c6]',
  tabButtonInactive: 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095] hover:text-[#e8d7c6]',
  modeButtonBase:
    'px-4 py-2 font-mono font-bold text-xs border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4a574]',
  modeButtonActive: 'bg-[#5a2a2a] border-[#8b4444] text-[#e8d7c6]',
  modeButtonInactive: 'bg-[#1a1a1a] border-[#4a4a4a] text-[#b0a095] hover:text-[#e8d7c6]',
  panel: 'border-2 border-[#8b4444] bg-[#1a1a1a] p-6',
  panelSpaced: 'border-2 border-[#8b4444] bg-[#1a1a1a] p-6 space-y-4',
} as const;

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
