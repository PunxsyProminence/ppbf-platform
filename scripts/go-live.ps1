# PPBF Go-Live Helper
Write-Host "=== PPBF Production Go-Live Checklist ===" -ForegroundColor Green
Write-Host ""
Write-Host "1. All code committed and pushed to GitHub"
Write-Host "2. Supabase project created and schema applied"
Write-Host "3. Environment variables set (.env.local or hosting platform)"
Write-Host "4. All DRAFT components promoted to ACTIVE (Jason approval)"
Write-Host "5. Safety Gate Matrix tested with real scenarios"
Write-Host "6. Continuity Ledger logging verified"
Write-Host "7. Bounded contexts enforced (no personal data leakage)"
Write-Host "8. CI/CD pipeline passing"
Write-Host "9. Final governance audit clean"
Write-Host ""
Write-Host "Only proceed to production after ALL items above are complete." -ForegroundColor Red
