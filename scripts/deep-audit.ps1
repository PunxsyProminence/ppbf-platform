$report = "DEEP_AUDIT_PPBF_SHADOW_2026-07-18.md"

if (-not (Test-Path $report)) {
    Write-Error "Deep audit report not found: $report"
    exit 1
}

Write-Host "=== PPBF Deep Audit Report ===" -ForegroundColor Cyan
Write-Host "Report: $report" -ForegroundColor Yellow
Write-Host ""
Get-Content $report
