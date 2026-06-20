# @ppbf/portals
Stakeholder portals: Athlete (13), Guardian (14), Public (15), Grant Reporting (16), Brand (17), Payment (gated 21).

Phase addition: payment.ts — strictly gated processPayment() requiring proofOfSuccess + jasonApproval.
New: SafetyBadge.tsx — reusable status badge (safe/review/blocked) for UI consistency.
New: DashboardLayout.tsx and MainNavigation.tsx — reusable governed layout and nav components for consistent dashboards.
New: reporting/reportGenerator.ts — generateMonthlyReport wrapping impact reports with governance flags.
