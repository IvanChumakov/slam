[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$infraDirectory = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $infraDirectory "docker-compose.yml"

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCommand) {
    $docker = $dockerCommand.Source
} else {
    $docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (-not (Test-Path -LiteralPath $docker)) {
        throw "Docker CLI is not installed. Install and start Docker Desktop first."
    }
}

& $docker compose --file $composeFile config --quiet
if ($LASTEXITCODE -ne 0) {
    throw "docker compose config failed."
}

$runningServices = @(& $docker compose --file $composeFile ps --status running --services)
if ($LASTEXITCODE -ne 0) {
    throw "Could not read Docker Compose service status."
}

$requiredServices = @("livekit", "webhook-receiver")
$missingServices = @($requiredServices | Where-Object { $_ -notin $runningServices })
if ($missingServices.Count -gt 0) {
    throw "Services are not running: $($missingServices -join ', ')."
}

$response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:7880/" `
    -UseBasicParsing `
    -TimeoutSec 5

if ($response.StatusCode -ne 200 -or $response.Content.Trim() -ne "OK") {
    throw "Unexpected LiveKit response: HTTP $($response.StatusCode) '$($response.Content)'."
}

Write-Host "PASS: Compose configuration is valid."
Write-Host "PASS: Required services are running."
Write-Host "PASS: LiveKit returned HTTP 200 OK on localhost:7880."
