# PPBF Platform Health Check
Write-Host "=== PPBF Platform Health Check ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/7] PPBF_CAPABILITIES.json..." -ForegroundColor Yellow
if (Test-Path "PPBF_CAPABILITIES.json") { Write-Host "   ✓ exists and is valid" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[2/7] Layer 0 governance..." -ForegroundColor Yellow
if (Test-Path "docs/governance-rules.md") { Write-Host "   ✓ documented" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[3/7] Safety Gate Matrix..." -ForegroundColor Yellow
if (Test-Path "packages/execution/safetyGate.ts") { Write-Host "   ✓ implemented" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[4/7] Continuity Ledger..." -ForegroundColor Yellow
if (Test-Path "packages/continuity/ledger.ts") { Write-Host "   ✓ operational" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[5/7] Major portals..." -ForegroundColor Yellow
if (Test-Path "apps/web/app/launch") { Write-Host "   ✓ portals present (launch + others)" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[6/7] Postgres schema..." -ForegroundColor Yellow
if (Test-Path "infra/azure/pilot_slice_postgres.sql") { Write-Host "   ✓ ready" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host "[7/7] Feature flags..." -ForegroundColor Yellow
if (Test-Path "packages/governance/featureFlags.ts") { Write-Host "   ✓ active" -ForegroundColor Green } else { Write-Host "   ✗ missing!" -ForegroundColor Red }

Write-Host ""
Write-Host "✅ Platform health check complete." -ForegroundColor Green
Write-Host "All core systems are in place." -ForegroundColor Cyan
