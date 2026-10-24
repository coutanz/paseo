<#
.SYNOPSIS
    Paseo Omni — Windows Node One-Click Setup (NetBird + Computer Use + Session 1+ Desktop Guard)

.DESCRIPTION
    1. Detects the local NetBird WireGuard IP (100.x.x.x) so the Paseo Daemon can be reached directly across your NetBird mesh.
    2. Injects Windows Computer Use (`windows-mcp`, `open-computer-use`) and Browser Use (`@playwright/mcp`) into Codex, Antigravity (`agy`), ZCode, and DeepSeek (`dsh`).
    3. Registers a Windows Scheduled Task (`PaseoOmniDaemon`) configured with `LogonType = Interactive` so all spawned CLI agents run inside the active GUI desktop session (Session 1+) instead of headless Session 0.
#>

param(
    [int]$Port = 6767,
    [string]$BindAddress = "",
    [string]$CdpEndpoint = "",
    [string[]]$ConnectHosts = @(),
    [switch]$SkipTaskRegistration
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "=== Paseo Omni: Windows Node Setup ===" -ForegroundColor Cyan

# 1. Detect NetBird Virtual IP
function Get-NetBirdIp {
    try {
        $nbCmd = Get-Command netbird -ErrorAction SilentlyContinue
        if ($nbCmd) {
            $statusJson = & netbird status --json 2>$null | ConvertFrom-Json
            if ($statusJson.netbirdIp) {
                return ($statusJson.netbirdIp -split "/")[0]
            }
        }
    } catch {}

    try {
        $adapter = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.InterfaceAlias -match "NetBird|wt0" -or $_.IPAddress -like "100.*" } |
            Select-Object -First 1
        if ($adapter) {
            return $adapter.IPAddress
        }
    } catch {}

    return "0.0.0.0"
}

if (-not $BindAddress) {
    $BindAddress = Get-NetBirdIp
}
$ListenEndpoint = "${BindAddress}:${Port}"
Write-Host "[1/4] Detected Bind Endpoint: $ListenEndpoint" -ForegroundColor Green

# 2. Synchronize Computer Use & Browser Use MCP across all 4 Agent CLIs
Write-Host "[2/4] Synchronizing Windows Computer Use & Browser Use MCP configs..." -ForegroundColor Green
$syncArgs = @("$RepoRoot\scripts\sync-computer-use-mcp.mjs")
if ($CdpEndpoint) {
    $syncArgs += @("--cdp-endpoint", $CdpEndpoint)
}
& node $syncArgs

# 3. Register Interactive Desktop Session Scheduled Task (Avoids Windows Session 0 Black Screen)
if (-not $SkipTaskRegistration) {
    Write-Host "[3/4] Registering Interactive Desktop Session Task (PaseoOmniDaemon)..." -ForegroundColor Green
    $TaskName = "PaseoOmniDaemon"
    $NodePath = (Get-Command node).Source
    $ServerEntry = Join-Path $RepoRoot "packages\server\dist\scripts\supervisor-entrypoint.js"

    $LauncherScript = Join-Path $env:USERPROFILE ".paseo\start-interactive-daemon.ps1"
    $LauncherContent = @"
`$env:PASEO_LISTEN = "$ListenEndpoint"
Set-Location "$RepoRoot"
if (Test-Path "$ServerEntry") {
    & "$NodePath" "$ServerEntry"
} else {
    & npm.cmd run start
}
"@
    New-Item -ItemType Directory -Force -Path (Split-Path $LauncherScript) | Out-Null
    Set-Content -Path $LauncherScript -Value $LauncherContent -Encoding UTF8

    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LauncherScript`""
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # Crucial for Windows Computer Use: Run only in the user's Interactive session (Session 1+) so GUI handles & screenshots work
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host "      Registered Scheduled Task '$TaskName' (Interactive Session 1+ mode)." -ForegroundColor Green
} else {
    Write-Host "[3/4] Skipped Scheduled Task registration." -ForegroundColor Yellow
}

# 4. Connect remote NetBird Paseo nodes if specified
if ($ConnectHosts.Count -gt 0) {
    Write-Host "[4/4] Connecting remote NetBird Paseo nodes..." -ForegroundColor Green
    foreach ($remoteHost in $ConnectHosts) {
        Write-Host "      Adding host: $remoteHost"
        & npm.cmd run cli -- host add $remoteHost
    }
} else {
    Write-Host "[4/4] Tip: Pass -ConnectHosts @('100.x.x.x:6767') to auto-register remote NetBird machines." -ForegroundColor Cyan
}

Write-Host "=== Windows Node Setup Complete! ===" -ForegroundColor Cyan
