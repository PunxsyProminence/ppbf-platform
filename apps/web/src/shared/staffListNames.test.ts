import { STAFF_LIST_NAME_FLOOR, staffListLabels, staffListNameFor } from './staffListNames';

describe('staffListNameFor: the typed name, else the login name, else the floor', () => {
  test('the name the gym typed wins, and a title typed in front is stripped', () => {
    expect(staffListNameFor({ account_id: 'a', login_email: 'c.rivera@example.org', staff_display_name: 'Sam Rivera', role: 'coach' })).toBe('Sam Rivera');
    // Every screen adds its own title, so a typed one comes off.
    expect(staffListNameFor({ account_id: 'a', login_email: 'x@example.org', staff_display_name: 'Coach Sam', role: 'coach' })).toBe('Sam');
  });

  test('without a typed name, the name the login gives', () => {
    expect(staffListNameFor({ account_id: 'a', login_email: 'sam.rivera@example.org', role: 'coach' })).toBe('Sam Rivera');
  });

  test('a role-word login names nobody: the floor', () => {
    for (const login of ['admin@example.org', 'info@example.org', 'ppbf@example.org', 'coach@example.org']) {
      expect(staffListNameFor({ account_id: 'a', login_email: login, role: 'organization_admin' })).toBe(STAFF_LIST_NAME_FLOOR);
    }
  });

  test('no login and no typed name is the floor, never the account id', () => {
    expect(staffListNameFor({ account_id: 'acct-secret-1', role: 'coach' })).toBe(STAFF_LIST_NAME_FLOOR);
    expect(staffListNameFor({ account_id: 'acct-secret-1', login_email: '', role: 'coach' })).not.toContain('acct-secret-1');
  });

  test('the typed name is read only for a role that may carry one (the rule storedStaffNameSql applies)', () => {
    const stale = { account_id: 'a', login_email: 'dana@example.org', staff_display_name: 'Dana Old Name' };
    for (const role of ['parent', 'athlete', 'board', 'platform_owner', null, undefined]) {
      expect(staffListNameFor({ ...stale, role })).toBe('Dana');
    }
    for (const role of ['coach', 'staff', 'organization_admin', 'admin', 'volunteer']) {
      expect(staffListNameFor({ ...stale, role })).toBe('Dana Old Name');
    }
  });

  test('the typed name is not read once the membership has ended', () => {
    const left = { account_id: 'a', login_email: 'dana@example.org', staff_display_name: 'Dana Old Name', role: 'coach' };
    expect(staffListNameFor({ ...left, membership_active: false })).toBe('Dana');
    expect(staffListNameFor({ ...left, membership_active: true })).toBe('Dana Old Name');
    expect(staffListNameFor({ ...left, membership_active: null })).toBe('Dana Old Name');
  });

  test('a typed name that is only a title or a role word falls back to the login', () => {
    expect(staffListNameFor({ account_id: 'a', login_email: 'dana@example.org', staff_display_name: 'Coach', role: 'coach' })).toBe('Dana');
  });
});

describe('staffListLabels: two who read the same are numbered, never told apart by address', () => {
  test('numbers in the order given, "(1 of 2)"', () => {
    const labels = staffListLabels([
      { account_id: 'a1', login_email: 'dana@one.example.org', role: 'coach' },
      { account_id: 'b1', login_email: 'rosa@example.org', role: 'coach' },
      { account_id: 'a2', login_email: 'dana@two.example.org', role: 'coach' },
    ]);
    expect(labels.get('a1')).toBe('Dana (1 of 2)');
    expect(labels.get('a2')).toBe('Dana (2 of 2)');
    expect(labels.get('b1')).toBe('Rosa');
  });

  test('a typed name and a login name that read the same are numbered together', () => {
    const labels = staffListLabels([
      { account_id: 'a1', login_email: 'x@example.org', staff_display_name: 'Dana', role: 'coach' },
      { account_id: 'a2', login_email: 'dana@example.org', role: 'volunteer' },
    ]);
    expect([labels.get('a1'), labels.get('a2')]).toEqual(['Dana (1 of 2)', 'Dana (2 of 2)']);
  });

  test('several shared accounts all read the floor, and are numbered', () => {
    const labels = staffListLabels([
      { account_id: 'a', login_email: 'info@example.org', role: 'staff' },
      { account_id: 'b', login_email: 'admin@example.org', role: 'admin' },
      { account_id: 'c', login_email: 'ppbf@example.org', role: 'organization_admin' },
    ]);
    expect([...labels.values()]).toEqual([
      `${STAFF_LIST_NAME_FLOOR} (1 of 3)`,
      `${STAFF_LIST_NAME_FLOOR} (2 of 3)`,
      `${STAFF_LIST_NAME_FLOOR} (3 of 3)`,
    ]);
  });

  test('the same account listed twice is one person, not two Danas', () => {
    const labels = staffListLabels([
      { account_id: 'a1', login_email: 'dana@example.org', role: 'coach' },
      { account_id: 'a1', login_email: 'dana@example.org', role: 'coach' },
    ]);
    expect(labels.get('a1')).toBe('Dana');
    expect(labels.size).toBe(1);
  });

  test('no label ever carries a sign-in address or an account id', () => {
    const labels = staffListLabels([
      { account_id: 'acct-secret-9', login_email: 'dana@example.org', role: 'coach' },
      { account_id: 'acct-secret-8', role: 'coach' },
    ]);
    for (const label of labels.values()) {
      expect(label).not.toContain('@');
      expect(label).not.toContain('acct-secret');
    }
  });
});
