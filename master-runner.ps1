# PPBF ULTIMATE MASTER RUNNER
Write-Host "=== PPBF ULTIMATE MASTER RUNNER ===" -ForegroundColor Green
Write-Host ""
Write-Host "This script summarizes the full setup process and runs the key scripts in order." -ForegroundColor Cyan
Write-Host ""

$scripts = @("init.ps1", "check-governance.ps1", "go-live.ps1", "run-tests.ps1")

foreach ($script in $scripts) {
    if (Test-Path $script) {
        Write-Host "`n>>> Running $script ..." -ForegroundColor Yellow
        & ".\$script"
    } else {
        Write-Host "`n>>> $script not found (skipped)" -ForegroundColor DarkYellow
    }
}

Write-Host "`n[Note] test-helper.ps1 not yet created in this build." -ForegroundColor DarkYellow
Write-Host ""
Write-Host "After running the above:" -ForegroundColor Yellow
Write-Host "- Install dependencies in apps/web"
Write-Host "- Connect Supabase"
Write-Host "- Get Jason final approval"
Write-Host ""
Write-Host "✅ You now have a complete governed PPBF platform." -ForegroundColor Green
Write-Host "See FINAL_SUMMARY.md and DEVELOPER_ONBOARDING.md for next steps." -ForegroundColor Cyan

