# Implementation Sequence

1. Azure connectivity validation
   - Confirm the backend can reach Azure PostgreSQL, Blob Storage, and Key Vault from the intended runtime.
   - Verify environment variables and secret delivery before changing auth flow.

2. Backend auth endpoints
   - Implement or move to production endpoints for login, logout, session, and roles.
   - Keep the browser out of the trust boundary.

3. Session verification
   - Make the session cookie the source of truth.
   - Validate session state server-side before any role decision is exposed to the UI.

4. Role authorization
   - Enforce role checks on the backend.
   - Use frontend checks only for visibility and navigation hints.

5. Tenant enforcement
   - Add `tenant_id` to all multi-gym tables.
   - Apply tenant scoping to queries, joins, and storage paths.

6. Smoke tests
   - Validate login, logout, session refresh, role routing, and tenant-scoped access.

7. Production deployment
   - Deploy after auth, session, and tenant boundaries are verified end to end.

## Dependency Order

Backend auth must land before tenant enforcement because tenant context depends on a trusted principal.
