[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$GeneratedDirectory,

    [string]$ExpectedLiveKitVersion = "v1.13.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedDirectory = (Resolve-Path -LiteralPath $GeneratedDirectory).Path
$requiredFiles = @("caddy.yaml", "docker-compose.yaml", "livekit.yaml", "redis.conf")

foreach ($file in $requiredFiles) {
    $path = Join-Path $resolvedDirectory $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing generated file: $path"
    }
}

$bootstrapFiles = @(
    Get-ChildItem -LiteralPath $resolvedDirectory -File |
        Where-Object { $_.Name -eq "init_script.sh" -or $_.Name -like "cloud_init.*.yaml" }
)
if ($bootstrapFiles.Count -eq 0) {
    throw "Missing init_script.sh or cloud_init.*.yaml."
}

$compose = Get-Content -LiteralPath (Join-Path $resolvedDirectory "docker-compose.yaml") -Raw -Encoding UTF8
$livekit = Get-Content -LiteralPath (Join-Path $resolvedDirectory "livekit.yaml") -Raw -Encoding UTF8
$caddy = Get-Content -LiteralPath (Join-Path $resolvedDirectory "caddy.yaml") -Raw -Encoding UTF8

$checks = [ordered]@{
    "Compose contains LiveKit" = $compose -match "livekit/livekit-server:"
    "Compose contains Redis" = $compose -match "(?m)^\s*redis:"
    "Compose contains Caddy" = $compose -match "(?m)^\s*caddy:"
    "LiveKit uses external IP discovery" = $livekit -match "(?m)^\s*use_external_ip:\s*true\s*$"
    "LiveKit has Redis configuration" = $livekit -match "(?m)^redis:\s*$"
    "LiveKit has TURN configuration" = $livekit -match "(?m)^turn:\s*$"
    "LiveKit enables TURN" = $livekit -match "(?m)^\s*enabled:\s*true\s*$"
    "Caddy config is not empty" = -not [string]::IsNullOrWhiteSpace($caddy)
}

$failedChecks = @($checks.GetEnumerator() | Where-Object { -not $_.Value })
foreach ($check in $checks.GetEnumerator()) {
    $status = if ($check.Value) { "PASS" } else { "FAIL" }
    Write-Host "${status}: $($check.Key)"
}

if ($failedChecks.Count -gt 0) {
    throw "Generated configuration failed $($failedChecks.Count) structural check(s)."
}

$imageMatch = [regex]::Match($compose, "livekit/livekit-server:(?<version>[A-Za-z0-9._-]+)")
if (-not $imageMatch.Success) {
    throw "Could not determine LiveKit image version from docker-compose.yaml."
}

$generatedVersion = $imageMatch.Groups["version"].Value
if ($generatedVersion -ne $ExpectedLiveKitVersion) {
    Write-Warning "Generator selected LiveKit '$generatedVersion'; project currently pins '$ExpectedLiveKitVersion'. Review release notes and pin the generated Compose file before deployment."
} else {
    Write-Host "PASS: LiveKit image is pinned to $ExpectedLiveKitVersion."
}

Write-Host "PASS: generated deployment contains all required files."
Write-Host "SECURITY: generated files may contain API secrets; do not add them to Git."
