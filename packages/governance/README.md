# @ppbf/governance
Layer 0 Governance. Feature flags via PPBF_CAPABILITIES.json. Jason-only promotion. PIN 15715 for admin desks.

Phase 2: featureFlags.ts (isFeatureEnabled, getEnabledCapabilities, ROUTING_MATRIX)
Advanced: boundedContext.ts (enforceBoundedContext for nonprofit vs personal isolation)
New: errorHandler.ts — handlePPBFError for centralized logging + governance review.
New: version.ts — PPBF_VERSION info and getVersionInfo() for platform metadata.
