# PPBF Master Initialization Script
Write-Host "=== PPBF Full Platform Initialization ===" -ForegroundColor Cyan

Write-Host "`n[1/6] Creating directory structure..." -ForegroundColor Yellow
# (Already created in previous batches)

Write-Host "`n[2/6] Applying Supabase schema..." -ForegroundColor Yellow
Write-Host "   → Run: psql or Supabase dashboard → infra/supabase/schema.sql"

Write-Host "`n[3/6] Installing dependencies..." -ForegroundColor Yellow
Write-Host "   → cd apps/web && npm install"

Write-Host "`n[4/6] Running governance checks..." -ForegroundColor Yellow
Write-Host "   → All components must pass Layer 0 review"

Write-Host "`n[5/6] Promoting DRAFT items to ACTIVE..." -ForegroundColor Yellow
Write-Host "   → Requires Jason approval"

Write-Host "`n[6/6] Final verification..." -ForegroundColor Yellow
Write-Host "   → Run: npm run dev in apps/web"

Write-Host "`n✅ Initialization script complete. Follow the steps above." -ForegroundColor Green
