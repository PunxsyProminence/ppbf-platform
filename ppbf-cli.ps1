# PPBF Simple CLI Helper
param(
    [string]$Command
)

switch ($Command.ToLower()) {
    "status"   { if (Test-Path ".\final-master-status.ps1") { .\final-master-status.ps1 } else { Write-Host "final-master-status.ps1 not found" -ForegroundColor Red } }
    "health"   { if (Test-Path ".\health-check.ps1") { .\health-check.ps1 } else { Write-Host "health-check.ps1 not found" -ForegroundColor Red } }
    "govern"   { if (Test-Path ".\check-governance.ps1") { .\check-governance.ps1 } else { Write-Host "check-governance.ps1 not found" -ForegroundColor Red } }
    "golive"   { if (Test-Path ".\go-live.ps1") { .\go-live.ps1 } else { Write-Host "go-live.ps1 not found" -ForegroundColor Red } }
    "summary"  { if (Test-Path ".\ultimate-summary.ps1") { .\ultimate-summary.ps1 } else { Write-Host "ultimate-summary.ps1 not found" -ForegroundColor Red } }
    "quick"    { if (Test-Path ".\quick-reference.ps1") { .\quick-reference.ps1 } else { Write-Host "quick-reference.ps1 not found" -ForegroundColor Red } }
    "everything" { if (Test-Path ".\MASTER_EVERYTHING_REFERENCE.md") { Get-Content ".\MASTER_EVERYTHING_REFERENCE.md" } else { Write-Host "MASTER_EVERYTHING_REFERENCE.md not found" -ForegroundColor Red } }
    "closing"  { if (Test-Path ".\final-closing.ps1") { .\final-closing.ps1 } else { Write-Host "final-closing.ps1 not found" -ForegroundColor Red } }
    "ultimate" { if (Test-Path ".\ultimate-platform-summary.ps1") { .\ultimate-platform-summary.ps1 } else { Write-Host "ultimate-platform-summary.ps1 not found" -ForegroundColor Red } }
    "thankyou" { if (Test-Path ".\THANK_YOU_CLOSING.md") { Get-Content ".\THANK_YOU_CLOSING.md" } else { Write-Host "THANK_YOU_CLOSING.md not found" -ForegroundColor Red } }
    "readiness" { if (Test-Path ".\final-readiness-check.ps1") { .\final-readiness-check.ps1 } else { Write-Host "final-readiness-check.ps1 not found" -ForegroundColor Red } }
    "closingdoc" { if (Test-Path ".\ULTIMATE_CLOSING_DOCUMENT.md") { Get-Content ".\ULTIMATE_CLOSING_DOCUMENT.md" } else { Write-Host "ULTIMATE_CLOSING_DOCUMENT.md not found" -ForegroundColor Red } }
    "final"    { if (Test-Path ".\final-completion.ps1") { .\final-completion.ps1 } else { Write-Host "final-completion.ps1 not found" -ForegroundColor Red } }
    "complete" { if (Test-Path ".\final-completion.ps1") { .\final-completion.ps1 } else { Write-Host "final-completion.ps1 not found" -ForegroundColor Red } }
    "ultimateproject" { if (Test-Path ".\ULTIMATE_PROJECT_SUMMARY.md") { Get-Content ".\ULTIMATE_PROJECT_SUMMARY.md" } else { Write-Host "ULTIMATE_PROJECT_SUMMARY.md not found" -ForegroundColor Red } }
    "all"      { 
        Write-Host "Running all checks..." -ForegroundColor Cyan
        .\health-check.ps1
        .\check-governance.ps1
        .\go-live.ps1
    }
    default    { 
        Write-Host "PPBF CLI - Available commands:" -ForegroundColor Cyan
        Write-Host "  status   → Show platform status"
        Write-Host "  health   → Run health check"
        Write-Host "  govern   → Run governance check"
        Write-Host "  golive   → Show go-live checklist"
        Write-Host "  summary  → Show ultimate summary"
        Write-Host "  quick    → Daily quick reference"
        Write-Host "  everything → Show master everything reference"
        Write-Host "  closing  → Run final closing script"
        Write-Host "  ultimate → Run ultimate platform summary"
        Write-Host "  thankyou → Show thank you & closing document"
        Write-Host "  readiness → Run final readiness check"
        Write-Host "  closingdoc → Show ultimate closing document"
        Write-Host "  final    → Run final completion script"
        Write-Host "  complete → Run final completion script"
        Write-Host "  ultimateproject → Show ultimate project summary"
        Write-Host "  all      → Run health + govern + golive"
    }
}
