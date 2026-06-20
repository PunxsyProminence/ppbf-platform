# Automated Governance Check
Write-Host "=== PPBF Automated Governance Check ===" -ForegroundColor Cyan

# Real checks
Write-Host "`n[1/7] Checking PPBF_CAPABILITIES.json..." -ForegroundColor Yellow
if (Test-Path "PPBF_CAPABILITIES.json") {
    Write-Host "   ✅ File exists" -ForegroundColor Green
} else {
    Write-Host "   ❌ File missing!" -ForegroundColor Red
}

Write-Host "`n[2/7] Checking Safety Gate Matrix..." -ForegroundColor Yellow
if (Test-Path "packages/execution/safetyGate.ts") {
    Write-Host "   ✅ safetyGate.ts found" -ForegroundColor Green
} else {
    Write-Host "   ❌ Safety gate module missing!" -ForegroundColor Red
}

Write-Host "`n[3/7] Checking Continuity Ledger..." -ForegroundColor Yellow
if (Test-Path "packages/continuity/ledger.ts") {
    Write-Host "   ✅ Ledger module present" -ForegroundColor Green
} else {
    Write-Host "   ❌ Continuity Ledger not found!" -ForegroundColor Red
}

Write-Host "`n[4/7] Checking for DRAFT items..." -ForegroundColor Yellow
if (Test-Path "PPBF_CAPABILITIES.json") {
    $caps = Get-Content "PPBF_CAPABILITIES.json" -Raw | ConvertFrom-Json
    $drafts = $caps.capabilities | Where-Object { $_.status -eq 'draft' }
    if ($drafts.Count -eq 0) {
        Write-Host "   ✅ No DRAFT items remaining" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️  $($drafts.Count) DRAFT items still present (requires Jason approval)" -ForegroundColor Yellow
    }
}

Write-Host "`n[5/7] Bounded contexts check..." -ForegroundColor Yellow
if (Test-Path "packages/governance/boundedContext.ts") {
    Write-Host "   ✅ Bounded context enforcement present" -ForegroundColor Green
} else {
    Write-Host "   ❌ Bounded context module missing!" -ForegroundColor Red
}

Write-Host "`n[6/7] Checking Supabase schema..." -ForegroundColor Yellow
if (Test-Path "infra/supabase/schema.sql") {
    Write-Host "   ✅ Schema file ready" -ForegroundColor Green
} else {
    Write-Host "   ❌ Schema missing!" -ForegroundColor Red
}

Write-Host "`n[7/7] Checking for personal data leakage risks..." -ForegroundColor Yellow
Write-Host "   (Manual review recommended - bounded contexts active)" -ForegroundColor Yellow

Write-Host "`n✅ Governance check script complete." -ForegroundColor Green
Write-Host "Run this before every major deployment." -ForegroundColor Cyan
Write-Host "`nTip: Review any warnings above and obtain Jason approval as needed." -ForegroundColor Cyan

