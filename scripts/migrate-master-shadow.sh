#!/bin/bash
set -e

# Migration script to add has_master_shadow_access column
psql "$AZURE_POSTGRES_CONNECTION_STRING" <<EOF
ALTER TABLE pilot.accounts ADD COLUMN IF NOT EXISTS has_master_shadow_access boolean NOT NULL DEFAULT false;
SELECT 'Migration completed successfully' as result;
EOF
