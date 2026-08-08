[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "generated")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Pinned official generator image inspected on 2026-08-08.
$generatorImage = "livekit/generate@sha256:6bbb3cdc829d4eabfb2bc63ce56fd3ed154e8a5428264e52362507c2f997d02a"

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCommand) {
    $docker = $dockerCommand.Source
} else {
    $docker = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (-not (Test-Path -LiteralPath $docker)) {
        throw "Docker CLI is not installed. Install and start Docker Desktop first."
    }
}

$stagingRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)

if (-not $resolvedOutput.StartsWith($stagingRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must stay inside '$stagingRoot'."
}

if (Test-Path -LiteralPath $resolvedOutput) {
    $existingEntries = @(Get-ChildItem -LiteralPath $resolvedOutput -Force)
    if ($existingEntries.Count -gt 0) {
        throw "Output directory is not empty: '$resolvedOutput'. Move or review existing generated secrets before continuing."
    }
} else {
    New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}

& $docker image inspect $generatorImage *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Pulling pinned official LiveKit generator..."
    & $docker pull $generatorImage
    if ($LASTEXITCODE -ne 0) {
        throw "Could not pull $generatorImage."
    }
}

Write-Host "The generator is interactive. Choose LiveKit Server only; do not enable Ingress or Egress for this MVP."
Write-Host "Generated files can contain credentials and will stay under the Git-ignored staging/generated directory."

$mount = "type=bind,source=$resolvedOutput,target=/output"
& $docker run --rm -it --mount $mount $generatorImage
if ($LASTEXITCODE -ne 0) {
    throw "LiveKit generator exited with code $LASTEXITCODE."
}

$requiredFiles = @("caddy.yaml", "docker-compose.yaml", "livekit.yaml", "redis.conf")
$candidateDirectories = @(
    Get-ChildItem -LiteralPath $resolvedOutput -Directory |
        Where-Object {
            $candidate = $_.FullName
            ($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $candidate $_)) }).Count -eq 0
        }
)

if ($candidateDirectories.Count -ne 1) {
    throw "Expected exactly one generated deployment directory, found $($candidateDirectories.Count)."
}

$generatedDirectory = $candidateDirectories[0].FullName
Write-Host "Generated deployment: $generatedDirectory"

& (Join-Path $PSScriptRoot "Test-GeneratedStagingConfig.ps1") `
    -GeneratedDirectory $generatedDirectory
