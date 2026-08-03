# On-demand, verified backup of the pilot schema to a file on this machine.
#
# The scheduled backup is .github/workflows/backup.yml, which dumps the pilot
# schema every night and stores it in the ppbf-pilot-backups blob container.
# This script is the manual companion: the copy you take in your own hands
# before doing something you might need to undo, and the one you can restore
# from without any Azure access at all.
#
# It refuses rather than reassures. A dump that cannot be verified against the
# live row counts is renamed so nobody mistakes it for a backup, and the script
# exits non-zero. Nothing here prints the connection string, and nothing here
# prints a row.
#
# USAGE
#   $env:AZURE_POSTGRES_CONNECTION_STRING = '<connection string>'
#   ./scripts/backup-export.ps1 `
#       -ExpectedHostname 'ppbf-pg-<name>.postgres.database.azure.com' `
#       -ExpectedDatabase 'postgres'
#
# REQUIRES
#   pg_dump on PATH, at a major version not older than the server.
#   node, and apps/web dependencies installed (the verifier uses `pg`).

[CmdletBinding()]
param(
    [string]$ConnectionString = $env:AZURE_POSTGRES_CONNECTION_STRING,

    # Named, not derived. This is the guard that stops a shell holding a
    # production connection string from quietly producing a file everyone then
    # believes is staging -- the same contract the migration runners enforce.
    [string]$ExpectedHostname = $env:PPBF_EXPECTED_POSTGRES_HOSTNAME,
    [string]$ExpectedDatabase = $env:PPBF_EXPECTED_POSTGRES_DATABASE,

    # Defaults outside the repository on purpose: this repository is public,
    # and the file this script produces contains every athlete record, every
    # guardian, and every PIN hash in the gym.
    [string]$OutputDirectory = (Join-Path $HOME 'ppbf-backups')
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($ConnectionString)) {
    throw 'Set AZURE_POSTGRES_CONNECTION_STRING, or pass -ConnectionString.'
}
if ([string]::IsNullOrWhiteSpace($ExpectedHostname)) {
    throw 'Name the database you intend to back up: pass -ExpectedHostname (or set PPBF_EXPECTED_POSTGRES_HOSTNAME).'
}
if ([string]::IsNullOrWhiteSpace($ExpectedDatabase)) {
    throw 'Name the database you intend to back up: pass -ExpectedDatabase (or set PPBF_EXPECTED_POSTGRES_DATABASE).'
}

# Parsed rather than pattern-matched, and never echoed. A connection string
# carries credentials, so every failure below reports the mismatch without
# quoting the value that caused it.
try {
    $target = [System.Uri]$ConnectionString
}
catch {
    throw 'INVALID_POSTGRES_CONNECTION_STRING'
}
if ($target.Scheme -notin @('postgres', 'postgresql')) {
    throw 'INVALID_POSTGRES_PROTOCOL'
}

$targetHostname = $target.Host.ToLowerInvariant()
$targetDatabase = [System.Uri]::UnescapeDataString($target.AbsolutePath.TrimStart('/'))

if ([string]::IsNullOrWhiteSpace($targetHostname) -or [string]::IsNullOrWhiteSpace($targetDatabase)) {
    throw 'INCOMPLETE_POSTGRES_TARGET'
}
if ($targetHostname -ne $ExpectedHostname.Trim().ToLowerInvariant() -or $targetDatabase -ne $ExpectedDatabase.Trim()) {
    throw "POSTGRES_TARGET_MISMATCH: the connection string points at $targetHostname/$targetDatabase, not $($ExpectedHostname.Trim())/$($ExpectedDatabase.Trim())."
}

$pgDump = Get-Command 'pg_dump' -ErrorAction SilentlyContinue
if ($null -eq $pgDump) {
    throw 'pg_dump was not found on PATH. Install the PostgreSQL client tools at a major version no older than the server.'
}

$node = Get-Command 'node' -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw 'node was not found on PATH. The dump verifier runs on node, and an unverified dump is not a backup.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$resolvedRepository = [System.IO.Path]::GetFullPath($repositoryRoot)
if ($resolvedOutput.StartsWith($resolvedRepository, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write a database dump inside the repository ($resolvedOutput). This repository is public. Choose -OutputDirectory somewhere else."
}

if (-not (Test-Path -LiteralPath $resolvedOutput)) {
    New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$plainPath = Join-Path $resolvedOutput "pilot-$targetDatabase-$stamp.sql"
$dumpPath = Join-Path $resolvedOutput "pilot-$targetDatabase-$stamp.sql.gz"

Write-Host '=== PPBF pilot schema backup ===' -ForegroundColor Cyan
Write-Host "Target:      $targetHostname / $targetDatabase"
Write-Host "Destination: $dumpPath"
Write-Host ''
Write-Host 'Dumping...' -ForegroundColor Yellow

# Plain SQL so the restore is `gunzip -c <file> | psql <target>` with no
# pg_restore version matching to get right. --no-owner/--no-privileges so the
# restore does not depend on the role names of the server it came from.
& $pgDump.Source `
    '--schema=pilot' `
    '--format=plain' `
    '--encoding=UTF8' `
    '--no-owner' `
    '--no-privileges' `
    "--file=$plainPath" `
    "--dbname=$ConnectionString"

if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $plainPath) { Remove-Item -LiteralPath $plainPath -Force }
    throw "pg_dump exited with code $LASTEXITCODE. No backup was produced."
}

if (-not (Test-Path -LiteralPath $plainPath) -or (Get-Item -LiteralPath $plainPath).Length -eq 0) {
    if (Test-Path -LiteralPath $plainPath) { Remove-Item -LiteralPath $plainPath -Force }
    throw 'pg_dump produced an empty file. No backup was produced.'
}

Write-Host 'Compressing...' -ForegroundColor Yellow

$sourceStream = [System.IO.File]::OpenRead($plainPath)
try {
    $targetStream = [System.IO.File]::Create($dumpPath)
    try {
        $gzipStream = New-Object System.IO.Compression.GZipStream($targetStream, [System.IO.Compression.CompressionLevel]::Optimal)
        try {
            $sourceStream.CopyTo($gzipStream)
        }
        finally {
            $gzipStream.Dispose()
        }
    }
    finally {
        $targetStream.Dispose()
    }
}
finally {
    $sourceStream.Dispose()
}

Remove-Item -LiteralPath $plainPath -Force

Write-Host 'Verifying against the live row counts...' -ForegroundColor Yellow

# The same verifier the scheduled workflow runs. It reads the dump back and
# refuses a file that is truncated, schema-only, or missing a table that holds
# rows -- the failures a size check cannot see.
$previousConnection = $env:AZURE_POSTGRES_CONNECTION_STRING
$previousHostname = $env:PPBF_EXPECTED_POSTGRES_HOSTNAME
$previousDatabase = $env:PPBF_EXPECTED_POSTGRES_DATABASE

Push-Location (Join-Path $repositoryRoot 'apps/web')
try {
    $env:AZURE_POSTGRES_CONNECTION_STRING = $ConnectionString
    $env:PPBF_EXPECTED_POSTGRES_HOSTNAME = $ExpectedHostname
    $env:PPBF_EXPECTED_POSTGRES_DATABASE = $ExpectedDatabase

    & $node.Source 'scripts/pilot-export-verify-dump.mjs' 'verify' '--dump' $dumpPath
    $verifyExitCode = $LASTEXITCODE
}
finally {
    $env:AZURE_POSTGRES_CONNECTION_STRING = $previousConnection
    $env:PPBF_EXPECTED_POSTGRES_HOSTNAME = $previousHostname
    $env:PPBF_EXPECTED_POSTGRES_DATABASE = $previousDatabase
    Pop-Location
}

if ($verifyExitCode -ne 0) {
    # Renamed rather than deleted: the file is still evidence of what went
    # wrong, and it must not sit in the backup folder under a name that reads
    # like a backup.
    $rejectedPath = Join-Path $resolvedOutput "pilot-$targetDatabase-$stamp.UNVERIFIED.sql.gz"
    Move-Item -LiteralPath $dumpPath -Destination $rejectedPath -Force
    Write-Host ''
    Write-Host 'VERIFICATION FAILED. This is not a backup.' -ForegroundColor Red
    Write-Host "The file was kept for diagnosis at: $rejectedPath" -ForegroundColor Red
    exit 1
}

$sizeBytes = (Get-Item -LiteralPath $dumpPath).Length

Write-Host ''
Write-Host 'Backup complete and verified.' -ForegroundColor Green
Write-Host "  File:    $dumpPath"
Write-Host "  Size:    $sizeBytes bytes (compressed)"
Write-Host "  Restore: gunzip -c `"$dumpPath`" | psql <connection string of an empty database>"
Write-Host ''
Write-Host 'This file is unencrypted and contains every athlete record, every guardian,' -ForegroundColor Yellow
Write-Host 'every emergency contact and every PIN hash in that gym. Nothing deletes it and' -ForegroundColor Yellow
Write-Host 'no retention policy applies to it -- it lives until you remove it.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'The scheduled backup is the .github/workflows/backup.yml run, retained 90 days.' -ForegroundColor Cyan
