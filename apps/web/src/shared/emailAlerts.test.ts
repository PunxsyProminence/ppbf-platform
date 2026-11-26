import fs from 'node:fs';
import path from 'node:path';

import { EMAIL_ALERT_USER_TYPES, emailAlertCandidateUserType, isEmailAlertUserType } from './emailAlerts';

/*
 * Who may have an email alert switch (lane W4-1, EM-1). OW27-02 C: "Coach,
 * admin, organization admin and parents", plus athletes 18 or over. The user
 * type 'staff' is OW27-10's word for those coaches and admins; the account
 * role 'staff' gets nothing.
 */

describe('emailAlertCandidateUserType', () => {
  it.each([
    ['coach', 'staff'],
    ['admin', 'staff'],
    ['organization_admin', 'staff'],
    ['parent', 'parent'],
    ['athlete', 'adult_athlete'],
  ])('%s switches as %s', (role, userType) => {
    expect(emailAlertCandidateUserType(role)).toBe(userType);
  });

  it.each(['staff', 'volunteer', 'board', 'platform_owner', '', 'Coach', 'unknown'])(
    'the role %p gets no switch',
    (role) => {
      expect(emailAlertCandidateUserType(role)).toBeNull();
    },
  );
});

describe('the user types', () => {
  it('are exactly the three OW27-10 names, the same three the table CHECK allows', () => {
    expect(EMAIL_ALERT_USER_TYPES).toEqual(['staff', 'parent', 'adult_athlete']);
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../infra/azure/pilot_slice_postgres_email_alert_switches_migration.sql'),
      'utf8',
    );
    const match = sql.match(/check \(user_type in \(([^)]*)\)\)/);
    expect(match?.[1].split(',').map((part) => part.trim().replace(/'/g, ''))).toEqual([...EMAIL_ALERT_USER_TYPES]);
  });

  it.each([['staff', true], ['parent', true], ['adult_athlete', true], ['athlete', false], ['coach', false], [null, false], [1, false]])(
    'isEmailAlertUserType(%p) is %p',
    (value, expected) => {
      expect(isEmailAlertUserType(value)).toBe(expected);
    },
  );
});
