/**
 * A session role in the words a person reads (F-122: the header pill printed
 * "platform_owner", /shadow "ROLE: PLATFORM_OWNER"). The words are the ones the
 * People page already shows (app/admin/people/page.tsx roleLabel): both admin
 * spellings are "Gym Admin", the platform role is "Platform Owner", every
 * other role is its own word capitalised.
 *
 * A role this list does not know still never shows raw: underscores become
 * spaces and each word is capitalised.
 */
const ROLE_WORDS: Readonly<Record<string, string>> = {
  platform_owner: 'Platform Owner',
  organization_admin: 'Gym Admin',
  admin: 'Gym Admin',
  coach: 'Coach',
  athlete: 'Athlete',
  parent: 'Parent',
  board: 'Board',
  volunteer: 'Volunteer',
  staff: 'Staff',
};

export function roleWords(role: string | null | undefined): string {
  const key = (role ?? '').trim();
  if (!key) return '';
  const known = ROLE_WORDS[key];
  if (known) return known;
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
