# PPBF Project Sequence Update (Capability-First)

Project: PPBF_BACKEND_READINESS_PROJECT
Mode: Architecture + Front-End Readiness Audit Only
Date: 2026-07-13

## Sequence Correction

The project sequence is formally updated to:

1. Capability Map
2. Core Entity Map
3. Relationship Map
4. Dataverse Blueprint
5. Backend Build Plan

## Why The Sequence Changes

Repository and front-end audit show that several intended capabilities are missing or partial, including AI/ML video analysis and broader intelligence systems. Designing backend entities before this gap map is completed creates architectural drift and incorrect entity scope.

## Required Inputs By Step

### Step 1: Capability Map

Required artifact:

- PPBF_CAPABILITY_MAP_REALITY_BASED.md
- PPBF_MISSING_CAPABILITY_REGISTER_REALITY_BASED.md
- PPBF_CAPABILITY_MAP_SELF_AUDIT.md

Required outputs:

- domain-by-domain status (EXISTS/PARTIAL/PLACEHOLDER/MISSING)
- roadmap visibility list
- backend mapping preconditions
- missing capability register (complete)
- self-audit gate report (complete)

Hard Gate:

- Do not create the Core Entity Map until all three Step 1 artifacts are complete.

### Step 2: Core Entity Map

Required artifact:

- PPBF_CORE_ENTITY_MAP_REALITY_BASED.md

Restriction:

- may only model entities from validated capability states and explicitly approved roadmap candidates

### Step 3: Relationship Map

Required output:

- entity relationships anchored in approved Step 2 entities only

### Step 4: Dataverse Blueprint

Required output:

- Dataverse table blueprint derived only from approved relationship model

### Step 5: Backend Build Plan

Required output:

- phased implementation plan with no speculative systems

## Front-End Readiness Rule

Planned capabilities should remain visible in UI with clear state labels, but must not be represented as implemented backend workflows until approved in sequence.
