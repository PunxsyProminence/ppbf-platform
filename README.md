# PPBF Platform

**Version 2.0** - Merged Architecture (Original 25 Capabilities + 200 Detailed Modules)

## What This Is
A nonprofit, safety-first, adaptive performance platform using boxing as the main training vehicle.

## Key Features
- 25 high-level governed capabilities
- 200 detailed functional modules merged in
- Safety Gate + Red Flag Escalation
- Coach Review Queue
- Full participant spectrum support (Youth → AF_SPECOPS)

## Quick Start
1. Run .\setup.ps1
2. Configure Azure grant route env in apps/web (.env.local)
3. Apply infra/azure/pilot_slice_postgres.sql using npm run pilot:apply-schema from apps/web
4. Run npm run pilot:preflight and npm run gate:pilot from apps/web

## Governance
All changes go through Layer 0. Jason final approval required.

Status: **DRAFT**
