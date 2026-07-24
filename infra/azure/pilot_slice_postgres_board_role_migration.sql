-- Additive aggregate-only Board role migration.
-- Apply after the canonical pilot schema and multi-organization migration.
begin;

do $pilot_board_role_constraints$
declare
  role_constraint record;
begin
  for role_constraint in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attname = 'role'
    where c.conrelid = 'pilot.accounts'::regclass
      and c.contype = 'c'
      and c.conkey = array[a.attnum]::smallint[]
  loop
    execute format(
      'alter table pilot.accounts drop constraint %I',
      role_constraint.conname
    );
  end loop;

  alter table pilot.accounts
    add constraint accounts_role_check
    check (
      role in (
        'platform_owner',
        'organization_admin',
        'admin',
        'coach',
        'athlete',
        'parent',
        'board',
        'volunteer',
        'staff'
      )
    );

  for role_constraint in
    select c.conname
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attname = 'role'
    where c.conrelid = 'pilot.organization_memberships'::regclass
      and c.contype = 'c'
      and c.conkey = array[a.attnum]::smallint[]
  loop
    execute format(
      'alter table pilot.organization_memberships drop constraint %I',
      role_constraint.conname
    );
  end loop;

  alter table pilot.organization_memberships
    add constraint organization_memberships_role_check
    check (
      role in (
        'platform_owner',
        'organization_admin',
        'admin',
        'coach',
        'athlete',
        'parent',
        'board',
        'volunteer',
        'staff'
      )
    );
end
$pilot_board_role_constraints$;

commit;
