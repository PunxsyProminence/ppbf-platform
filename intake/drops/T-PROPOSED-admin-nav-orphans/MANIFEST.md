# T-PROPOSED-admin-nav-orphans

**Status:** Lane B proposal (self-found). Convert to T-nnn at gate if accepted.

## FINDING

These routes exist as `apps/web/app/admin/*/page.tsx` but had no
`href="/admin/..."` entry on the capability-room header in
`apps/web/app/admin/page.tsx`:

- `/admin/pin`
- `/admin/board-seats`
- `/admin/volunteer-management`
- `/admin/feedback`
- `/admin/public-interest`
- `/admin/platform`

## HOW TO REFUTE

```bash
rg -n 'href="/admin/pin"|href="/admin/board-seats"|href="/admin/volunteer-management"|href="/admin/feedback"|href="/admin/public-interest"|href="/admin/platform"' apps/web/app/admin/page.tsx
```

On this branch those hrefs should appear. On main before the change, they should not.

## Files

| Path | Kind |
|------|------|
| `apps/web/app/admin/page.tsx` | REPLACES |
| `intake/drops/T-PROPOSED-admin-nav-orphans/MANIFEST.md` | NEW |

## Role gating (matches existing page comments)

| Link | Visible when |
|------|----------------|
| ATHLETE PINS | `canManagePeople` (org admin) — pin console refuses platform_owner |
| BOARD SEATS | `canManagePeople` — page admits admin + board |
| VOLUNTEERS, FEEDBACK, PUBLIC INTEREST | Always on this page — target pages admit admin + platform_owner |
| PLATFORM | Always on this page — platform operator surface |

## What this does NOT do

- Does not change any subpage logic or APIs
- Does not add `/admin/gear/vendors` or `/admin/platform/overview` (nested; reachable from parent surfaces)
- Does not add intake-review (not on main as a route in this tree)
- Does not change RoleSessionGate on `/admin` itself

## Behavioral claims

- Org admin sees PIN + BOARD SEATS in the header — **UNVERIFIED — needs CI/gate confirmation**
- Platform owner does not see PIN / BOARD SEATS (same as PEOPLE) — **UNVERIFIED — needs CI/gate confirmation**
- All listed routes are one click from the capability room for a role their page admits — **UNVERIFIED — needs CI/gate confirmation**
