$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot

try {
    Write-Host "=== Running PPBF validation ===" -ForegroundColor Cyan

    & npm test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & npm run test:migrations -- --runInBand --detectOpenHandles
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & npm run lint
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & npm run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "All PPBF validation checks passed." -ForegroundColor Green
}
finally {
    Pop-Location
}

