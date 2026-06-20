# PPBF Quick Reference Commands
Write-Host "=== PPBF Quick Reference ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Common Commands:" -ForegroundColor Yellow
Write-Host "  npm run dev          → Start development server (in apps/web or coach-review)"
Write-Host "  git status           → Check current changes"
Write-Host "  git add .            → Stage all changes"
Write-Host "  git commit -m 'msg'  → Commit with message"
Write-Host "  git push             → Push to GitHub"
Write-Host ""
Write-Host "Governance Commands:" -ForegroundColor Yellow
Write-Host "  Run: check-governance.ps1"
Write-Host "  Run: go-live.ps1"
Write-Host "  Run: ultimate-summary.ps1"
Write-Host ""
Write-Host "File Checks:" -ForegroundColor Yellow
if (Test-Path "PPBF_CAPABILITIES.json") { Write-Host "  ✅ PPBF_CAPABILITIES.json present" -ForegroundColor Green } else { Write-Host "  ❌ Missing!" -ForegroundColor Red }
if (Test-Path "packages/execution/safetyGate.ts") { Write-Host "  ✅ Safety Gate module present" -ForegroundColor Green } else { Write-Host "  ❌ Missing!" -ForegroundColor Red }
if (Test-Path "packages/continuity/ledger.ts") { Write-Host "  ✅ Continuity Ledger present" -ForegroundColor Green } else { Write-Host "  ❌ Missing!" -ForegroundColor Red }
Write-Host ""
Write-Host "✅ Keep this as your daily reference." -ForegroundColor Green

