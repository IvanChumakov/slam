[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^[A-Za-z0-9_-]+$")]
    [string]$Identity,

    [string]$DisplayName = $Identity,

    [ValidatePattern("^[A-Za-z0-9_-]+$")]
    [string]$Room = "test-room",

    [ValidatePattern("^[0-9]+[smh]$")]
    [string]$ValidFor = "1h",

    [switch]$OpenMeet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$infraDirectory = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $infraDirectory ".env"
$envValues = @{}

if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        if ($line -match "^\s*#" -or [string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line -match "^\s*([^=]+?)\s*=\s*(.*)\s*$") {
            $envValues[$Matches[1]] = $Matches[2]
        }
    }
}
function Get-Setting {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$Default
    )

    $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue
    }
    if ($envValues.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($envValues[$Name])) {
        return $envValues[$Name]
    }
    return $Default
}

$livekitUrl = Get-Setting -Name "LIVEKIT_URL" -Default "ws://localhost:7880"
$apiKey = Get-Setting -Name "LIVEKIT_API_KEY" -Default "devkey"
$apiSecret = Get-Setting `
    -Name "LIVEKIT_API_SECRET" `
    -Default "local-development-secret-change-me"

$lkCommand = Get-Command lk -ErrorAction SilentlyContinue
if ($lkCommand) {
    $lk = $lkCommand.Source
} else {
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $lk = Get-ChildItem `
        -Path $wingetPackages `
        -Recurse `
        -Filter "lk.exe" `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*LiveKit.LiveKitCLI*" } |
        Select-Object -First 1 -ExpandProperty FullName

    if (-not $lk) {
        throw "LiveKit CLI is not installed. Install package LiveKit.LiveKitCLI with winget."
    }
}

$previousUrl = $env:LIVEKIT_URL
$previousKey = $env:LIVEKIT_API_KEY
$previousSecret = $env:LIVEKIT_API_SECRET

try {
    $env:LIVEKIT_URL = $livekitUrl
    $env:LIVEKIT_API_KEY = $apiKey
    $env:LIVEKIT_API_SECRET = $apiSecret

    $arguments = @(
        "token", "create",
        "--join",
        "--room", $Room,
        "--identity", $Identity,
        "--name", $DisplayName,
        "--allow-source", "microphone",
        "--valid-for", $ValidFor
    )

    if ($OpenMeet) {
        $arguments += @("--open", "meet")
    } else {
        $arguments += "--token-only"
    }

    & $lk @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "LiveKit CLI failed to create a token."
    }
} finally {
    $env:LIVEKIT_URL = $previousUrl
    $env:LIVEKIT_API_KEY = $previousKey
    $env:LIVEKIT_API_SECRET = $previousSecret
}
