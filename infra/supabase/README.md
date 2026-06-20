# PPBF Supabase Infrastructure

This directory contains Supabase configuration and schema definitions aligned with the 25-capability PPBF architecture.

## Core Schema

The main schema is defined in `ppbf_core_schema.sql` (and mirrored in migration for deployment).

Key tables:
- `governance_manifest`: Layer 0 governance and audit (tracks active source, promotions, status).
- `participant_profiles`: Core participant records with JSONB for assessments and profiles.
- `session_logs`: Session tracking with RPE, skills, safety flags.
- `development_routes`: Goal intake and routing for development paths.

## Row Level Security (RLS)
- Enabled on profiles and logs.
- Example policy for coaches/admins.

## Usage
1. Deploy schema via Supabase CLI or dashboard.
2. Use with the monorepo packages (e.g., governance, routing).
3. Aligns with PPBF_CAPABILITIES.json and governance rules.

See `../migration/` for versioned SQL migrations.

For full architecture, refer to docs/00_MASTER_BLUEPRINT.md (to be created) and PPBF_CAPABILITIES.json.