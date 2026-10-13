// The twelve lines infra/azure/pilot_slice_postgres_org_quotes_migration.sql
// seeds, exactly as that applied (never rewritten) file writes them. They were
// components/gymSayings.ts as of 2026-08-19. Since owner ruling D19
// (OD-2026-10-08-009) the file has egg 11 changed -- Steel Town off,
// AMPLECTERE MISERIAM on -- and the library gets the same change from its own
// migration (PR #1491, org-quotes-d19). Tests about the seed read this list,
// not the file, so the two can no longer drift apart silently.
export const ORG_QUOTES_SEEDED_SAYINGS: ReadonlyArray<{
  line: string;
  said_by: string;
  shown: readonly string[];
}> = [
  { line: 'OBSERVE. DECIDE. EXECUTE. REPEAT.', said_by: 'the wall', shown: ['anywhere'] },
  { line: "POOR MAN'S SPORT", said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SAFETY FIRST. KIDS FIRST.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SHOW UP. DO THE WORK. GO HOME BETTER.', said_by: 'the wall', shown: ['after-hard-session'] },
  { line: "THE WORK DOESN'T LIE", said_by: 'the wall', shown: ['after-hard-session'] },
  { line: 'KEEP THE STANDARD. KEEP THE KIDS.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'HANDS UP. HEAD CLEAR.', said_by: 'the wall', shown: ['after-hard-session'] },
  { line: 'NO HYPE. JUST WORK.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'SHADOW NOTICES THE PATTERN', said_by: 'the wall', shown: ['at-a-milestone'] },
  { line: 'CHECK IN. THEN WORK.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'STEEL TOWN. STEADY HANDS.', said_by: 'the wall', shown: ['anywhere'] },
  { line: 'WE BUILD PEOPLE, NOT JUST FIGHTERS.', said_by: 'the wall', shown: ['at-a-milestone'] },
];
