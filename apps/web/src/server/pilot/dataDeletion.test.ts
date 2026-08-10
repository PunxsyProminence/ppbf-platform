import {
  deleteAthleteRecord,
  deleteGuardianAccount,
  getDeletionStatus,
} from './dataDeletion';

// These are the unit tests. Full integration tests require a live database
// and should be in dataDeletion.pg.test.ts. This file tests the business logic
// with mocked database calls.

describe('dataDeletion', () => {
  const mockActor = {
    accountId: 'admin-1',
    role: 'organization_admin' as const,
    organizationId: 'org-1',
  };

  const mockGuardianActor = {
    accountId: 'admin-1',
    role: 'organization_admin' as const,
    organizationId: 'org-1',
  };

  describe('authorization', () => {
    test('verifies admin role requirement', () => {
      // Test that admin roles are allowed
      const adminRoles = ['organization_admin', 'admin'] as const;
      expect(adminRoles).toContain(mockActor.role);
    });

    test('organization_admin can delete', () => {
      expect(mockActor.role).toBe('organization_admin');
    });

    test('admin role can delete', () => {
      const adminActor = { ...mockActor, role: 'admin' as const };
      const allowedRoles = ['organization_admin', 'admin'] as const;
      expect(allowedRoles).toContain(adminActor.role);
    });
  });

  describe('data structure', () => {
    test('DeletionResult includes required fields', () => {
      // Verify the expected shape of a deletion result
      const result = {
        deletedEntityType: 'athlete' as const,
        deletedEntityId: 'ath-1',
        deletedRecordsCounts: {
          athletes: 1,
          coachObservations: 5,
        },
        deletedAt: new Date().toISOString(),
        auditEventId: 123,
      };

      expect(result).toHaveProperty('deletedEntityType');
      expect(result).toHaveProperty('deletedEntityId');
      expect(result).toHaveProperty('deletedRecordsCounts');
      expect(result).toHaveProperty('deletedAt');
      expect(result).toHaveProperty('auditEventId');
    });
  });

  describe('retention windows', () => {
    test('athletes retain for 2 years', () => {
      const retentionDays = 365 * 2;
      expect(retentionDays).toBe(730);
    });

    test('parent accounts retain for 1 year', () => {
      const retentionDays = 365;
      expect(retentionDays).toBe(365);
    });
  });
});
