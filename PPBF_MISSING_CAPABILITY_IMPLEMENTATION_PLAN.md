# PPBF Missing Capability Implementation Plan

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Front-End Capability Design Only
Date: 2026-07-13

## Guardrails

- No backend implementation
- No API creation
- No Dataverse tables
- No SQL
- No authentication changes
- No payment systems
- No persistence implementation

This document defines front-end scaffolds, navigation visibility, and architecture planning surfaces only.

## Current Platform Audit Baseline

Existing anchor surfaces in current platform:

- Mission Control: apps/web/app/operations/page.tsx
- Athlete workspace: apps/web/app/athlete/dashboard/page.tsx
- Coach workspace: apps/web/app/coach/review-queue/page.tsx
- Parent workspace: apps/web/app/parent/dashboard/page.tsx
- Admin hub: apps/web/app/admin/page.tsx
- Board workspaces: apps/web/app/board/*
- Development Lab surfaces: apps/web/app/research/page.tsx, apps/web/app/evidence/page.tsx, apps/web/app/knowledge-graph/page.tsx, apps/web/app/simulator/page.tsx, apps/web/app/source-control/page.tsx
- SHADOW surfaces: apps/web/app/shadow/page.tsx, apps/web/app/admin/shadow/page.tsx
- Revenue/Funding surface: apps/web/components/RevenueFundingCenter.tsx

## Capability Placement Audit

| Capability | Best Workspace | Alternative Workspace | Visibility Needs | Role Access Needs |
|---|---|---|---|---|
| AI/ML Video Analysis | Coach Workspace + Development Lab | Athlete Workspace (read-only summary), Admin Hub (oversight) | Mission Control roadmap card + Coach nav entry + Dev Lab card | Primary: Coach/Admin. Secondary: Athlete read-only. Board summary only. |
| Automated Compliance Monitoring | Admin Hub + Board Workspace | SHADOW Ops (alerts panel), Mission Control status strip | Mission Control capability card + Admin tab + Board compliance tab badge | Primary: Admin/Board. Secondary: Coach read-only safety notices. |
| Closed-Loop Progression Intelligence | Athlete Workspace + Coach Workspace | Mission Control trend summary + Parent progress snapshot | Mission Control capability card + Athlete tab + Coach tab | Primary: Athlete/Coach. Secondary: Parent limited visibility, Admin overview. |
| Automated Publication Workflow | Development Lab + Source Control | Research and Evidence pages + Admin governance panel | Mission Control capability card + Development Lab card + Source Control queue indicator | Primary: Admin/Board/Research roles. Secondary: Coach read-only publication status. |

## Workspace Visibility Matrix

Legend: P=Primary, S=Secondary, N=Not needed now

| Surface | AI/ML Video Analysis | Automated Compliance Monitoring | Closed-Loop Progression Intelligence | Automated Publication Workflow |
|---|---|---|---|---|
| Mission Control | P | P | P | P |
| Athlete | S | N | P | N |
| Coach | P | S | P | S |
| Parent | N | N | S | N |
| Admin | P | P | S | P |
| Board | S | P | S | P |
| Development Lab | P | S | S | P |
| Revenue | N | S | N | N |
| SHADOW | S | P | S | S |
| Public Portal | N | N | N | N |

## Capability 1: AI/ML Video Analysis

Current Status:

- Missing as implemented capability
- Roadmap-visible only

Recommended Front-End Location:

- Primary: Coach Workspace as Video Intelligence area
- Secondary: Development Lab as Video Analysis Studio (planning surface)

Required Navigation Changes:

- Mission Control capability card remains visible with state
- Add Coach nav item: Video Intelligence (PLANNED)
- Add Development Lab card: Video Analysis Studio (PLANNED)

Required Placeholder Surfaces:

- Video Library
- Video Upload
- Video Review
- Coach Annotation
- Athlete Feedback
- Skill Recognition Placeholder (PLANNED - NOT YET IMPLEMENTED)
- Footwork Analysis Placeholder (PLANNED - NOT YET IMPLEMENTED)
- Punch Detection Placeholder (PLANNED - NOT YET IMPLEMENTED)
- Technique Scoring Placeholder (PLANNED - NOT YET IMPLEMENTED)
- Session Comparison
- Before/After Comparison
- Analysis History

Backend Dependency:

- Required later for media storage, indexing, and workflow orchestration

Dataverse Dependency:

- Required later for metadata, annotation records, and history entities

Future AI Dependency:

- Required later for recognition/scoring/detection features

Risk Level:

- High

Implementation Priority:

- P1 (roadmap-critical)

## Capability 2: Automated Compliance Monitoring

Current Status:

- Missing as implemented automated capability
- Compliance monitoring currently partial/manual across existing surfaces

Recommended Front-End Location:

- Primary: Admin Hub compliance monitoring workspace
- Secondary: Board compliance tab extensions

Required Navigation Changes:

- Mission Control capability card with state badge
- Add Admin nav item: Compliance Monitor (PLANNED)
- Add Board nav sub-entry under Compliance: Monitoring Watch (PLANNED)

Required Placeholder Surfaces:

- Compliance Dashboard
- Policy Review Queue
- Required Review Dates
- Board Compliance Watch
- Safety Monitoring
- Governance Monitoring
- Audit Monitoring

Backend Dependency:

- Required later for rule execution and event ingestion

Dataverse Dependency:

- Required later for policy artifacts, due-date entities, and monitoring records

Future AI Dependency:

- Optional future layer for risk summarization (not required for first implementation)

Risk Level:

- High

Implementation Priority:

- P1

## Capability 3: Closed-Loop Progression Intelligence

Current Status:

- Missing as closed-loop intelligence capability
- Existing progress/readiness features are partial and distributed

Recommended Front-End Location:

- Primary: Athlete and Coach workspaces as linked intelligence views
- Secondary: Mission Control trend strips and Parent read-only summary

Required Navigation Changes:

- Mission Control capability card with state badge
- Add Athlete nav item: Progression Intelligence (PLANNED)
- Add Coach nav item: Progression Intelligence (PLANNED)

Required Placeholder Surfaces:

- Assessment History
- Progress Tracking
- Goal Tracking
- Skill Progression
- Readiness Trends
- Coach Review Trends
- Development Recommendations (PLANNED - NOT YET IMPLEMENTED)
- Training History

Backend Dependency:

- Required later for longitudinal trend model and linked event history

Dataverse Dependency:

- Required later for assessment/progression/review entities and joins

Future AI Dependency:

- Optional for recommendation quality; must remain placeholder now

Risk Level:

- High

Implementation Priority:

- P1

## Capability 4: Automated Publication Workflow

Current Status:

- Missing as automated workflow
- Current publication path is manual/staged in Development Lab and Source Control surfaces

Recommended Front-End Location:

- Primary: Development Lab + Source Control
- Secondary: Research and Evidence pages for queue visibility

Required Navigation Changes:

- Mission Control capability card with state badge
- Add Development Lab card: Publication Workflow (PLANNED)
- Add Source Control sub-tabs: Approval Queue and Publication Queue (PLANNED)

Required Placeholder Surfaces:

- Research Review
- Approval Queue
- Publication Queue
- Publication History
- Destination Registry
- Source Status

Backend Dependency:

- Required later for state transitions, approvals, and destination delivery

Dataverse Dependency:

- Required later for artifact lifecycle entities and approval records

Future AI Dependency:

- Optional future assistant for review summarization; not needed for first delivery

Risk Level:

- Medium-High

Implementation Priority:

- P1

## Recommended Front-End Scaffold Route Map (Planning Only)

All routes below are planning scaffolds only and should show PLANNED + NOT YET IMPLEMENTED banners.

- /coach/video-intelligence
- /development/video-analysis-studio
- /admin/compliance-monitor
- /board/compliance-watch
- /athlete/progression-intelligence
- /coach/progression-intelligence
- /source-control/publication-workflow
- /research/publication-review

## Required Global Navigation Additions (Planning Only)

1. Mission Control capability cards keep state badges and button visibility
2. Coach nav adds Video Intelligence and Progression Intelligence
3. Athlete nav adds Progression Intelligence
4. Admin nav adds Compliance Monitor
5. Board compliance area adds Monitoring Watch
6. Development Lab adds Video Analysis Studio and Publication Workflow
7. Source Control adds Approval Queue and Publication Queue visibility

## What Should Not Be Built Yet

- No AI/ML inference pipelines
- No computer vision or model integration
- No compliance automation engines
- No scoring or prediction logic
- No publication orchestration backend
- No ingestion APIs, persistence layers, or workflow jobs
- No Dataverse schema implementation

## Priority Delivery Sequence (Front-End Only)

1. Mission Control visibility updates for all four capabilities
2. Navigation stubs and placeholder routes
3. Capability workspace shells with PLANNED and NOT YET IMPLEMENTED labels
4. Role-scoped visibility and read-only cards
5. Documentation updates in capability map and register references

## Success Check

The missing capabilities are visible in the front-end roadmap, placed in the correct workspaces, and explicitly bounded from backend implementation until later sequence steps.
