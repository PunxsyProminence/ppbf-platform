[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PassthroughArgs
)

$ErrorActionPreference = 'Stop'

Write-Host "=== Running authoritative PPBF workspace test suite ===" -ForegroundColor Cyan

$argsToForward = @('--workspace', 'web', 'run', 'test')
if ($PassthroughArgs -and $PassthroughArgs.Count -gt 0) {
    $argsToForward += '--'
    $argsToForward += $PassthroughArgs
}

& npm @argsToForward
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Workspace tests failed with exit code $exitCode"
}

Write-Host "Workspace tests passed." -ForegroundColor Green

