import fs from 'node:fs';
import path from 'node:path';

import {
  EMAIL_ALERT_EVENTS,
  EMAIL_ALERT_USER_TYPES,
  emailAlertCandidateUserType,
  isEmailAlertEventFor,
  isEmailAlertUserType,
} from './emailAlerts';

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

describe('the events each user type can be sent (EM-5)', () => {
  it('are Overwatch\'s Q1.9 reading, gym notices only (GO on #2159, condition 1)', () => {
    expect(EMAIL_ALERT_EVENTS).toEqual({
      staff: ['safety_escalation', 'parent_reply', 'gym_notice'],
      parent: ['family_note', 'gym_notice'],
      adult_athlete: ['coach_message', 'gym_notice'],
    });
  });

  it('the gym-choice table allows exactly the same three user types', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../infra/azure/pilot_slice_postgres_organization_email_alert_events_migration.sql'),
      'utf8',
    );
    const match = sql.match(/check \(user_type in \(([^)]*)\)\)/);
    expect(match?.[1].split(',').map((part) => part.trim().replace(/'/g, ''))).toEqual([...EMAIL_ALERT_USER_TYPES]);
  });

  it('the send log (EM-3) allows exactly the same three user types and the same key shape', () => {
    const sql = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../../infra/azure', file), 'utf8');
    const sends = sql('pilot_slice_postgres_email_alert_sends_migration.sql');
    const gymChoice = sql('pilot_slice_postgres_organization_email_alert_events_migration.sql');
    const types = sends.match(/check \(user_type in \(([^)]*)\)\)/);
    expect(types?.[1].split(',').map((part) => part.trim().replace(/'/g, ''))).toEqual([...EMAIL_ALERT_USER_TYPES]);
    const kindShape = (text: string) => text.match(/check \(event_kind ~ '([^']+)'\)/)?.[1];
    expect(kindShape(sends)).toBeDefined();
    expect(kindShape(sends)).toBe(kindShape(gymChoice));
  });

  it('every key has the shape the table CHECK allows', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../infra/azure/pilot_slice_postgres_organization_email_alert_events_migration.sql'),
      'utf8',
    );
    const pattern = sql.match(/check \(event_kind ~ '([^']+)'\)/)?.[1];
    expect(pattern).toBeDefined();
    for (const kinds of Object.values(EMAIL_ALERT_EVENTS)) {
      for (const kind of kinds) expect(kind).toMatch(new RegExp(pattern as string));
    }
  });

  it.each([
    ['staff', 'safety_escalation', true],
    ['staff', 'family_note', false],
    ['parent', 'family_note', true],
    ['parent', 'safety_escalation', false],
    ['adult_athlete', 'coach_message', true],
    ['adult_athlete', 'family_note', false],
    ['volunteer', 'gym_notice', false],
    ['staff', 'motivation', false],
    ['staff', null, false],
  ])('isEmailAlertEventFor(%p, %p) is %p', (userType, eventKind, expected) => {
    expect(isEmailAlertEventFor(userType, eventKind)).toBe(expected);
  });
});
