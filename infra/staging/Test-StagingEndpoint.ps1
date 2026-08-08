[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RtcDomain,

    [Parameter(Mandatory)]
    [string]$TurnDomain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-TcpPort {
    param(
        [Parameter(Mandatory)]
        [string]$HostName,

        [Parameter(Mandatory)]
        [int]$Port
    )

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait([TimeSpan]::FromSeconds(5))) {
            throw "Connection timed out."
        }
        $task.GetAwaiter().GetResult()
        Write-Host "PASS: TCP $HostName`:$Port is reachable."
    } finally {
        $client.Dispose()
    }
}

function Test-TlsCertificate {
    param(
        [Parameter(Mandatory)]
        [string]$HostName,

        [Parameter(Mandatory)]
        [int]$Port
    )

    $client = [Net.Sockets.TcpClient]::new($HostName, $Port)
    try {
        $stream = [Net.Security.SslStream]::new($client.GetStream(), $false)
        try {
            $stream.AuthenticateAsClient($HostName)
            $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($stream.RemoteCertificate)
            if ($certificate.NotAfter -le (Get-Date)) {
                throw "TLS certificate for $HostName is expired."
            }
            Write-Host "PASS: trusted TLS for $HostName is valid until $($certificate.NotAfter.ToString('u'))."
        } finally {
            $stream.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

Test-TcpPort -HostName $RtcDomain -Port 443
Test-TcpPort -HostName $RtcDomain -Port 7881
Test-TcpPort -HostName $TurnDomain -Port 443

Test-TlsCertificate -HostName $RtcDomain -Port 443
Test-TlsCertificate -HostName $TurnDomain -Port 443

$response = Invoke-WebRequest -Uri "https://$RtcDomain/" -UseBasicParsing -TimeoutSec 10
Write-Host "PASS: HTTPS endpoint returned HTTP $($response.StatusCode)."
Write-Host "MANUAL: UDP/ICE and TURN transport still require a real WebRTC client test."
