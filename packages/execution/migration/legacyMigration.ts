export interface LegacyRecord {
  source: string;
  participantName: string;
  data: any;
}

export function migrateFromSheets(records: LegacyRecord[]) {
  const migrated = records.map(record => ({
    id: crypto.randomUUID(),
    fullName: record.participantName,
    participantType: record.data.participantType || 'Beginner',
    migratedFrom: record.source,
    migratedAt: new Date().toISOString(),
    status: 'MIGRATED_PENDING_REVIEW',
  }));

  return {
    success: true,
    count: migrated.length,
    records: migrated,
    note: 'All migrated records require Jason approval before becoming ACTIVE',
  };
}

export function migrateFromAppsScript(data: any) {
  return {
    success: true,
    message: 'Apps Script migration placeholder ready',
    data,
  };
}
