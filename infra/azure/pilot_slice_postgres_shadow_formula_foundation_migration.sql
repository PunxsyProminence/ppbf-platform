-- Additive formula-runtime foundation migration.
-- Apply after pilot_slice_postgres_shadow_runtime_migration.sql.
-- Existing formula rows receive explicit legacy identities; new writes must
-- supply their own deterministic identities and policy snapshots.

begin;

alter table pilot.shadow_formula_observations
  add column if not exists dimensions jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text not null default gen_random_uuid()::text;

alter table pilot.shadow_formula_results
  add column if not exists calculation_key text not null default gen_random_uuid()::text,
  add column if not exists output_key text not null default 'value',
  add column if not exists policy_version text not null default 'legacy',
  add column if not exists parameters jsonb not null default '{}'::jsonb;

alter table pilot.shadow_formula_baseline_snapshots
  add column if not exists calculation_key text not null default gen_random_uuid()::text,
  add column if not exists metric_key text not null default 'legacy',
  add column if not exists unit text not null default 'unitless',
  add column if not exists policy_version text not null default 'legacy',
  add column if not exists parameters jsonb not null default '{}'::jsonb;

do $shadow_formula_foundation_precheck$
begin
  if exists (
    select 1
    from pilot.shadow_formula_observations
    where idempotency_key is null
       or length(btrim(idempotency_key)) not between 1 and 300
       or jsonb_typeof(dimensions) <> 'object'
  ) or exists (
    select 1
    from pilot.shadow_formula_observations
    group by organization_id, idempotency_key
    having count(*) > 1
  ) or exists (
    select 1
    from pilot.shadow_formula_observations
    where supersedes_observation_id is not null
    group by organization_id, supersedes_observation_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_FORMULA_FOUNDATION_PRECHECK_FAILED',
      detail = 'shadow_formula_observations';
  end if;

  if exists (
    select 1
    from pilot.shadow_formula_results
    where calculation_key is null
       or output_key is null
       or policy_version is null
       or length(btrim(calculation_key)) not between 1 and 300
       or length(btrim(output_key)) not between 1 and 120
       or length(btrim(policy_version)) not between 1 and 120
       or jsonb_typeof(parameters) <> 'object'
  ) or exists (
    select 1
    from pilot.shadow_formula_results
    group by organization_id, calculation_key
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_FORMULA_FOUNDATION_PRECHECK_FAILED',
      detail = 'shadow_formula_results';
  end if;

  if exists (
    select 1
    from pilot.shadow_formula_baseline_snapshots
    where calculation_key is null
       or metric_key is null
       or unit is null
       or policy_version is null
       or length(btrim(calculation_key)) not between 1 and 300
       or length(btrim(metric_key)) not between 1 and 200
       or length(btrim(unit)) not between 1 and 80
       or length(btrim(policy_version)) not between 1 and 120
       or jsonb_typeof(parameters) <> 'object'
  ) or exists (
    select 1
    from pilot.shadow_formula_baseline_snapshots
    group by organization_id, athlete_id, metric_key, calculation_key
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'SHADOW_FORMULA_FOUNDATION_PRECHECK_FAILED',
      detail = 'shadow_formula_baseline_snapshots';
  end if;
end
$shadow_formula_foundation_precheck$;

alter table pilot.shadow_formula_observations
  alter column idempotency_key set not null,
  alter column idempotency_key drop default;

alter table pilot.shadow_formula_results
  alter column calculation_key set not null,
  alter column calculation_key drop default,
  alter column output_key set not null,
  alter column output_key drop default,
  alter column policy_version set not null,
  alter column policy_version drop default;

alter table pilot.shadow_formula_baseline_snapshots
  alter column calculation_key set not null,
  alter column calculation_key drop default,
  alter column metric_key set not null,
  alter column metric_key drop default,
  alter column unit set not null,
  alter column unit drop default,
  alter column policy_version set not null,
  alter column policy_version drop default;

create unique index if not exists idx_shadow_formula_observations_idempotency
  on pilot.shadow_formula_observations(organization_id, idempotency_key);
create unique index if not exists idx_shadow_formula_observations_supersedes
  on pilot.shadow_formula_observations(organization_id, supersedes_observation_id)
  where supersedes_observation_id is not null;
create unique index if not exists idx_shadow_formula_results_calculation
  on pilot.shadow_formula_results(organization_id, calculation_key);
create index if not exists idx_shadow_formula_results_output_scope
  on pilot.shadow_formula_results(
    organization_id, athlete_id, formula_id, output_key, formula_version, computed_at desc
  );
create unique index if not exists idx_shadow_formula_baseline_calculation
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, metric_key, calculation_key
  );
create index if not exists idx_shadow_formula_baseline_metric_scope
  on pilot.shadow_formula_baseline_snapshots(
    organization_id, athlete_id, metric_key, formula_id, effective_at desc
  );

do $shadow_formula_foundation_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_observations'::regclass
      and conname = 'shadow_formula_observations_dimensions_check'
  ) then
    alter table pilot.shadow_formula_observations
      add constraint shadow_formula_observations_dimensions_check
      check (jsonb_typeof(dimensions) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_observations'::regclass
      and conname = 'shadow_formula_observations_idempotency_key_check'
  ) then
    alter table pilot.shadow_formula_observations
      add constraint shadow_formula_observations_idempotency_key_check
      check (length(btrim(idempotency_key)) between 1 and 300);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_results'::regclass
      and conname = 'shadow_formula_results_identity_check'
  ) then
    alter table pilot.shadow_formula_results
      add constraint shadow_formula_results_identity_check
      check (
        length(btrim(calculation_key)) between 1 and 300
        and length(btrim(output_key)) between 1 and 120
        and length(btrim(policy_version)) between 1 and 120
        and jsonb_typeof(parameters) = 'object'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.shadow_formula_baseline_snapshots'::regclass
      and conname = 'shadow_formula_baseline_identity_check'
  ) then
    alter table pilot.shadow_formula_baseline_snapshots
      add constraint shadow_formula_baseline_identity_check
      check (
        length(btrim(calculation_key)) between 1 and 300
        and length(btrim(metric_key)) between 1 and 200
        and length(btrim(unit)) between 1 and 80
        and length(btrim(policy_version)) between 1 and 120
        and jsonb_typeof(parameters) = 'object'
      );
  end if;
end
$shadow_formula_foundation_constraints$;

commit;
