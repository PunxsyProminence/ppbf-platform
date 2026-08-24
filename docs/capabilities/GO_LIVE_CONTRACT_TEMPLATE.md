# Go-Live Contract — <capability name>

One contract per meaningful product capability. Fill only what applies; do not
pad with requirements that don't fit the capability. Keep it concise.

## 1. Purpose
What this capability does, in one or two sentences.

## 2. Users
Who is allowed to use it (roles).

## 3. Status
CORE | FOUNDATION | DEVELOPMENT | VALIDATION | READY | ACTIVE | DEPRECATED

## 4. Dependencies
Platform capabilities, tables, services, SHADOW/AI/ML systems, external
systems, or feature flags it requires.

## 5. Production boundary
What it may do; what it must NOT affect while incomplete or disabled; whether
the base Platform/Admin/Coach/Athlete app keeps operating when it is
unavailable (it must).

## 6. Go-live requirements
Check every requirement that applies — implementation complete; org/tenant
isolation verified; authentication verified; authorization/role enforcement
verified; data-access boundaries verified; required migrations applied and
tested; persisted-data contracts verified; API contracts verified; input
validation verified; failure/error behavior verified; privacy verified;
applicable safety/safeguarding verified; SHADOW integration verified (if
applicable); AI/ML behavior validated (if applicable); model
failure/degradation behavior verified (if applicable); deterministic non-AI
fallback identified where required; targeted tests green; core-flow regression
tests green; relevant integration tests green; observability adequate;
capability can be disabled or isolated; rollback/kill switch exists where
appropriate; documentation reflects reality; explicit production approval
recorded where required.

## 7. Go-live test
A short deterministic end-to-end proof that the capability actually works.

## 8. Failure isolation
What happens when it fails. A failure here must not take down unrelated core
functionality.

## 9. Activation
Exactly what enables it: feature flag, route, navigation visibility, config,
deployment setting.

## 10. Rollback
How it is safely disabled.

## 11. Known gaps
Anything intentionally incomplete.
