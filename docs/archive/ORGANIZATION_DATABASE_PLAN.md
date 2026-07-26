# Organization Database Plan

## New core tables

### organizations

Required fields:

- organization_id uuid primary key
- organization_name text not null
- organization_type text not null
- status text not null check (status in ('active', 'inactive', 'suspended', 'pending'))
- created_at timestamptz not null default now()
- primary_admin_user_id uuid null
- contact_email text null
- contact_phone text null
- subscription_status text not null check (subscription_status in ('trial', 'active', 'past_due', 'canceled'))

Recommended constraints:

- unique(organization_name)
- index(status)
- index(subscription_status)

### organization_memberships

Users belong to exactly one organization initially.

Required fields:

- user_id uuid primary key
- organization_id uuid not null references organizations(organization_id)
- role text not null
- created_at timestamptz not null default now()
- active_flag boolean not null default true

Recommended constraints:

- check(role in ('platform_owner','organization_admin','coach','athlete','parent','volunteer','staff'))
- index(organization_id, role)
- index(organization_id, active_flag)

## Existing tables to extend with organization_id

### Current active schema tables

- profiles
- participants
- sessions
- coach_reviews
- safety_gates
- athlete_voice
- physical_training_logs
- continuity_ledger
- public.user_profiles
- pilot.accounts
- pilot.session_tokens
- pilot.athletes
- pilot.goals
- pilot.sessions
- pilot.coach_reviews
- pilot.shadow_intake
- pilot.audit_events

### Required domain tables to add as organization-owned entities

- parents
- volunteers
- staff
- attendance
- readiness
- assessments
- documents
- messages
- skills

## Key modeling decisions

1. organization_id is mandatory for private entities.
2. IDs that are currently globally unique strings should migrate toward organization-safe uniqueness patterns.
3. session token rows must carry organization context (directly or through account join guarantees).
4. audit events should include organization_id for isolation and analytics aggregation.

## Suggested uniqueness pattern examples

- athlete identifiers: unique(organization_id, athlete_id)
- account identifiers: unique(organization_id, account_id)
- goal identifiers: unique(organization_id, goal_id)

## PII and privacy controls

- private tables (medical/emergency/messages/private notes/documents) must require organization_id
- platform analytics tables/materialized views must exclude direct personal identifiers
