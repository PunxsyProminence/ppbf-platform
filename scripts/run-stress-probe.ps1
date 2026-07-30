$ErrorActionPreference = 'Stop'

$base = 'https://app-ppbf-production.purpledesert-3a75d580.eastus.azurecontainerapps.io'
$envFile = 'apps/web/.env.local'
if (-not (Test-Path $envFile)) { throw 'Missing apps/web/.env.local' }

$bootstrapLine = Get-Content $envFile | Where-Object { $_ -match '^\s*PPBF_PILOT_BOOTSTRAP_KEY=' } | Select-Object -First 1
if (-not $bootstrapLine) { throw 'Missing PPBF_PILOT_BOOTSTRAP_KEY in .env.local' }
$bootstrapKey = ($bootstrapLine -split '=', 2)[1].Trim().Trim('"').Trim("'")

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$adminAccountId = "stress_admin_$stamp"
$adminPin = '445566'
$orgId = "stress_org_$stamp"
$orgName = "Stress Org $stamp"
$cookieJar = Join-Path $env:TEMP "ppbf-stress-cookie-$stamp.txt"
$tempFiles = @($cookieJar)

function New-TempJsonFile {
  param(
    [string]$Name,
    [string]$Json
  )

  $path = Join-Path $env:TEMP "ppbf-stress-$Name-$stamp.json"
  Set-Content -Path $path -Value $Json -NoNewline -Encoding utf8
  $script:tempFiles += $path
  return $path
}

# Bootstrap admin (status only)
$bootstrapJson = @{
  account_id = $adminAccountId
  pin = $adminPin
  organization_id = $orgId
  organization_name = $orgName
  bootstrap_role = 'platform_owner'
} | ConvertTo-Json -Compress
$bootstrapRequestFile = New-TempJsonFile -Name 'bootstrap' -Json $bootstrapJson
$bootstrapResponseFile = Join-Path $env:TEMP "ppbf-stress-bootstrap-response-$stamp.json"
$tempFiles += $bootstrapResponseFile
$bootstrapStatus = curl.exe -s -o "$bootstrapResponseFile" -w "%{http_code}" -X POST "$base/api/pilot/admin/bootstrap" -H "Content-Type: application/json" -H "x-ppbf-bootstrap-key: $bootstrapKey" --data-binary "@$bootstrapRequestFile"
$bootstrapBody = if (Test-Path $bootstrapResponseFile) { Get-Content $bootstrapResponseFile -Raw } else { '' }
if ($bootstrapStatus -notin @('200', '201')) { throw "Bootstrap failed with status $bootstrapStatus body=$bootstrapBody" }

# Login and capture cookie jar
$loginJson = @{ account_id = $adminAccountId; pin = $adminPin } | ConvertTo-Json -Compress
$loginRequestFile = New-TempJsonFile -Name 'login' -Json $loginJson
$loginStatus = curl.exe -s -o NUL -w "%{http_code}" -c "$cookieJar" -X POST "$base/api/pilot/auth/login" -H "Content-Type: application/json" --data-binary "@$loginRequestFile"
if ($loginStatus -ne '200') { throw "Login failed with status $loginStatus" }

function Invoke-CurlProbe {
  param(
    [string]$Name,
    [int]$Count,
    [scriptblock]$Call
  )

  $times = @()
  $statusCounts = @{}
  for ($i = 0; $i -lt $Count; $i++) {
    $out = & $Call
    $parts = $out -split ' '
    $status = $parts[0]
    $ms = [Math]::Round(([double]$parts[1]) * 1000, 2)
    $times += $ms
    if (-not $statusCounts.ContainsKey($status)) { $statusCounts[$status] = 0 }
    $statusCounts[$status] += 1
  }

  $sorted = $times | Sort-Object
  $avg = [Math]::Round((($times | Measure-Object -Average).Average), 2)
  $p95Index = [Math]::Min([int]([Math]::Ceiling($sorted.Count * 0.95)) - 1, $sorted.Count - 1)
  $p95 = $sorted[$p95Index]
  $max = ($times | Measure-Object -Maximum).Maximum
  $statusSummary = ($statusCounts.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ','

  Write-Output "PROBE=$Name COUNT=$Count AVG_MS=$avg P95_MS=$p95 MAX_MS=$max STATUS=$statusSummary"
}

Invoke-CurlProbe -Name 'GET /login' -Count 50 -Call {
  curl.exe -s -o NUL -w "%{http_code} %{time_total}" "$base/login"
}

Invoke-CurlProbe -Name 'POST /api/pilot/auth/session (unauth)' -Count 50 -Call {
  curl.exe -s -o NUL -w "%{http_code} %{time_total}" -X POST "$base/api/pilot/auth/session" -H "Content-Type: application/json" -d "{}"
}

Invoke-CurlProbe -Name 'GET /api/pilot/auth/microsoft/start' -Count 30 -Call {
  curl.exe -s -o NUL -w "%{http_code} %{time_total}" "$base/api/pilot/auth/microsoft/start"
}

Invoke-CurlProbe -Name 'POST /api/pilot/auth/session (auth)' -Count 50 -Call {
  curl.exe -s -o NUL -w "%{http_code} %{time_total}" -b "$cookieJar" -X POST "$base/api/pilot/auth/session" -H "Content-Type: application/json" -d "{}"
}

$aiDebugStatus = curl.exe -s -o NUL -w "%{http_code}" -b "$cookieJar" "$base/api/pilot/shadow/debug"
$aiDebugBody = curl.exe -s -b "$cookieJar" "$base/api/pilot/shadow/debug"
Write-Output "AI_DEBUG_STATUS=$aiDebugStatus"
Write-Output "AI_DEBUG_BODY=$aiDebugBody"

$chatBody = @{ message = 'Stress probe: provide one sentence readiness guidance.'; preferAsync = $false } | ConvertTo-Json -Compress
$chatRequestFile = New-TempJsonFile -Name 'chat' -Json $chatBody
$aiChatStatus = curl.exe -s -o NUL -w "%{http_code}" -b "$cookieJar" -X POST "$base/api/pilot/shadow/chat" -H "Content-Type: application/json" --data-binary "@$chatRequestFile"
$aiChatBody = curl.exe -s -b "$cookieJar" -X POST "$base/api/pilot/shadow/chat" -H "Content-Type: application/json" --data-binary "@$chatRequestFile"
Write-Output "AI_CHAT_STATUS=$aiChatStatus"
Write-Output "AI_CHAT_BODY=$aiChatBody"

foreach ($file in $tempFiles) {
  if (Test-Path $file) { Remove-Item $file -Force }
}