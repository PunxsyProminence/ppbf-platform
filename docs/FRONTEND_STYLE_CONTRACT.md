# Frontend Style Contract (PPBF)

## Purpose
Lock visual consistency for all current and upcoming frontend work before backend integration.

## Source of Truth
- Shared style tokens and helper: apps/web/components/uiStyles.ts
- Global palette and typography variables: apps/web/app/globals.css

## Visual Language
1. Theme direction: boxing-gym, safety-first, governance-forward.
2. Palette baseline:
- Background: #0a0a0a
- Surface: #1a1a1a
- Accent red: #8b4444 / #5a2a2a
- Accent tan: #d4a574
- Body text: #e8d7c6
- Muted text: #b0a095 / #8a8a8a
3. Shape language: hard-edge panels and controls by default.

## Components and Patterns
1. Use tokenized classes from uiStyles.ts for tabs, mode buttons, and repeated panel shells.
2. Prefer shared primitives over copy-pasting class strings.
3. Keep hover/focus behavior consistent:
- focus-visible ring color: #d4a574
- active controls: #5a2a2a with #8b4444 borders

## Drift Guardrails
1. Avoid introducing slate/emerald/cyan theme fragments on active surfaces.
2. Avoid inline style blocks for layout/visual treatment unless required for dynamic values.
3. Keep rounded corners minimal and intentional; hard-edge remains default.
4. Any new route should reference existing styled routes and uiStyles tokens before adding new classes.

## Scope Notes
1. Legacy files under apps/web/src are out-of-band and should not drive current visual decisions.
2. Active app surfaces live under apps/web/app and apps/web/components.

## Done Criteria for New UI Work
1. Uses globals palette tokens and/or established color constants.
2. Uses uiStyles.ts patterns for repeatable controls.
3. No conflicting theme colors introduced.
4. Keyboard focus states are visible and consistent.
