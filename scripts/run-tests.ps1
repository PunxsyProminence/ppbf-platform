# PPBF Comprehensive Test Runner
Write-Host "=== Running PPBF Test Suite ===" -ForegroundColor Cyan

Write-Host "`n[1] Running workspace web test suite..." -ForegroundColor Yellow
& npm --workspace web run test
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "`n[2] Running workspace migration test suite..." -ForegroundColor Yellow
& npm --workspace web run test:migrations
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "`nOK All core tests passed (real workspace test suites)." -ForegroundColor Green
Write-Host "Run this before every major deployment or PR." -ForegroundColor Cyan

