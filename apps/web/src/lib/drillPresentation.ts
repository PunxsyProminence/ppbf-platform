// Presentation helpers for drill instruction (OD-2026-09-19-001).
//
// Pure and client-safe: no server imports. They change how stored values READ,
// never what is stored -- contact levels stay their CHECK-constrained enum in
// the database, and prose stays the text the author wrote.

const CONTACT_LEVEL_LABELS: Record<string, string> = {
  none: 'No contact',
  light_technical: 'Light technical contact',
  conditioned: 'Conditioned contact',
  controlled_sparring: 'Controlled sparring',
  open_sparring: 'Open sparring',
};

/** "light_technical" -> "Light technical contact". Unknown values degrade readably rather than vanishing. */
export function humanizeContactLevel(value: string | null | undefined): string {
  const key = (value ?? '').trim();
  if (!key) return 'Not stated';
  const known = CONTACT_LEVEL_LABELS[key];
  if (known) return known;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Ordered steps, but only where the author wrote them as steps.
 *
 * The source-manual drills separate execution steps with blank lines; the
 * generated drafts are a single paragraph. Splitting a paragraph on sentences
 * would invent a sequence the author never wrote, so a text with no line
 * breaks comes back as ONE item and is rendered as prose, not as a list.
 */
export function executionSteps(text: string | null | undefined): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  const byParagraph = trimmed.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph.map(collapseLineBreaks);
  const byLine = trimmed.split('\n').map((part) => part.trim()).filter(Boolean);
  return byLine.length > 1 ? byLine : [trimmed];
}

/** Newline-separated observations or corrections as a list; a single line stays a single item. */
export function listItems(text: string | null | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

function collapseLineBreaks(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

/** The three scale levels, named for what they do rather than by letter alone. */
export function scaleLevelName(level: string): string {
  switch (level) {
    case 'A':
      return 'Easier (A)';
    case 'B':
      return 'Standard (B)';
    case 'C':
      return 'Harder (C)';
    default:
      return level;
  }
}

/** An equipment value as a reader should see it: "none" means none is needed. */
export function equipmentLabel(equipment: string | null | undefined): string | null {
  const value = (equipment ?? '').trim();
  if (!value) return null;
  return value.toLowerCase() === 'none' ? 'No equipment needed' : value;
}

/**
 * Setup instructions and equipment, each under its true label.
 *
 * In 114 of the 119 seeded reference drills `standard_setup` is not setup
 * instructions at all: it holds the same equipment word as `equipment_needed`
 * ("focus mitt", "none"). Printing it under "Setup" is the mislabel the owner
 * ruled out (OD-2026-09-19-001). The rule is exact data equality -- setup that
 * IS the equipment value, or is "none", is shown as equipment -- never a guess
 * from how the prose reads. Both values stay stored as they are.
 */
export function setupAndEquipment(
  setup: string | null | undefined,
  equipment: string | null | undefined,
): { setup: string | null; equipment: string | null } {
  const setupText = (setup ?? '').trim();
  const equipmentText = (equipment ?? '').trim();
  const setupIsEquipment = setupText !== ''
    && (setupText.toLowerCase() === 'none' || setupText.toLowerCase() === equipmentText.toLowerCase());

  if (!setupText || setupIsEquipment) {
    // The equipment column is the authority on equipment; the setup word is
    // used only when equipment itself is blank.
    return { setup: null, equipment: equipmentLabel(equipmentText || setupText) };
  }
  return { setup: setupText, equipment: equipmentLabel(equipmentText) };
}
