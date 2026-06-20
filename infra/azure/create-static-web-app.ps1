#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Name = "ppbf-platform"
$ResourceGroup = "ppbf-rg"
$Location = "eastus2"
$Source = "https://github.com/PunxsyProminence/ppbf-platform"
$AppLocation = "apps/web"
$OutputLocation = ".next"
$Branch = "main"

$az = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
if (-not (Test-Path $az)) {
    $az = (Get-Command az -ErrorAction SilentlyContinue)?.Source
}
if (-not $az) {
    Write-Host "Azure CLI not found. Installing..."
    irm https://aka.ms/installazurecliwindows | iex
    $az = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
}

Write-Host "Azure CLI: $(& $az --version | Select-Object -First 1)"

$account = & $az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in. Opening browser for az login..."
    & $az login
}

$rgExists = & $az group exists --name $ResourceGroup
if ($rgExists -ne "true") {
    Write-Host "Creating resource group $ResourceGroup in $Location..."
    & $az group create --name $ResourceGroup --location $Location | Out-Null
}

$existing = & $az staticwebapp show --name $Name --resource-group $ResourceGroup 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Static Web App '$Name' already exists."
    & $az staticwebapp show --name $Name --resource-group $ResourceGroup
    exit 0
}

Write-Host "Creating Static Web App '$Name'..."
& $az staticwebapp create `
    --name $Name `
    --resource-group $ResourceGroup `
    --source $Source `
    --app-location $AppLocation `
    --output-location $OutputLocation `
    --branch $Branch `
    --location $Location `
    --login-with-github

Write-Host "Done. Default hostname:"
& $az staticwebapp show --name $Name --resource-group $ResourceGroup --query "defaultHostname" -o tsv