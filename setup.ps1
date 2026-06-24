# PPBF Platform Setup Script v2.0 (Merged + Schema)

Write-Host "=== PPBF Platform Setup ===" -ForegroundColor Green
Write-Host "Merged 25 + 200 Capabilities | DRAFT Mode" -ForegroundColor Yellow

if (-not (Test-Path "apps/web/package.json")) {
    Write-Host "Run: cd apps/web; npx create-next-app@latest . --yes --tailwind --eslint --typescript --force"
}

Write-Host "Apply infra/supabase/schema.sql in your Supabase project."
Write-Host "Ready for development and GitHub."
