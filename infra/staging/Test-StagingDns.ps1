[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ServerIPv4,

    [Parameter(Mandatory)]
    [string]$RtcDomain,

    [Parameter(Mandatory)]
    [string]$TurnDomain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$parsedAddress = $null
if (-not [Net.IPAddress]::TryParse($ServerIPv4, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw "ServerIPv4 must be a valid public IPv4 address."
}

if ($RtcDomain -eq $TurnDomain) {
    throw "RtcDomain and TurnDomain must be different DNS names."
}

function Test-Domain {
    param(
        [Parameter(Mandatory)]
        [string]$Domain,

        [Parameter(Mandatory)]
        [string]$ExpectedIPv4
    )

    if ([Uri]::CheckHostName($Domain) -ne [UriHostNameType]::Dns) {
        throw "Invalid DNS name: '$Domain'."
    }

    $aRecords = @(
        Resolve-DnsName -Name $Domain -Type A -DnsOnly -ErrorAction Stop |
            Where-Object Type -eq "A" |
            Select-Object -ExpandProperty IPAddress -Unique
    )

    if ($ExpectedIPv4 -notin $aRecords) {
        throw "$Domain resolves to [$($aRecords -join ', ')], expected $ExpectedIPv4. Disable HTTP proxying and point the DNS record directly to the VM."
    }

    $aaaaRecords = @(
        Resolve-DnsName -Name $Domain -Type AAAA -DnsOnly -ErrorAction SilentlyContinue |
            Where-Object Type -eq "AAAA" |
            Select-Object -ExpandProperty IPAddress -Unique
    )
    if ($aaaaRecords.Count -gt 0) {
        Write-Warning "$Domain also has AAAA record(s): $($aaaaRecords -join ', '). Keep them only if the VM has working public IPv6 and matching firewall rules."
    }

    Write-Host "PASS: $Domain resolves directly to $ExpectedIPv4."
}

Test-Domain -Domain $RtcDomain -ExpectedIPv4 $ServerIPv4
Test-Domain -Domain $TurnDomain -ExpectedIPv4 $ServerIPv4
