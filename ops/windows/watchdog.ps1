# watchdog.ps1 — the mid-session recovery layer (installed as scheduled task
# 'BridgeAdvRunsWatchdog', every 5 minutes). Closes the one gap in the trio:
#   * logon      -> BridgeAdvRuns task starts the launcher          (existing)
#   * app crash  -> the launcher's own loop restarts node in 3s     (existing)
#   * launcher gone -> THIS script notices and restarts the launcher (2026-08-04,
#     after the launcher console was closed mid-day and the app sat dark ~90 min)
# Deliberately conservative: it only ever ACTS when healthz is dead AND no
# launcher process exists — a crash-loop mid-retry, or a hung-but-supervised
# node, is left alone (that's UptimeRobot's cue to page a human, not ours to
# kill blind). External-path failures (Funnel/Tailscale/internet) are invisible
# from here by nature — that is exactly why UptimeRobot exists alongside this.
$ErrorActionPreference = 'SilentlyContinue'
# This script lives in <app>\ops\windows; the app root is two levels up. Derived, not hardcoded,
# so the checkout can live anywhere.
$dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcherCmd = Join-Path $PSScriptRoot 'start-bridge.cmd'
$log = Join-Path $dir 'watchdog.log'

function Write-Log($msg) {
  # Tiny self-rotation so an unattended flap can never grow an unbounded file.
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    Move-Item -Force $log "$log.old"
  }
  Add-Content -Path $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
}

# 1. Healthy? Then leave without a trace (no log spam every 5 minutes).
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 8
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

# 2. App is dark. Is a launcher already alive (its 3s crash-loop mid-retry, or
#    a boot in progress)? Then starting a second one would duplicate supervisors.
$launcher = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'start-bridge' }
if ($launcher) { Write-Log 'healthz dead but a launcher is alive - leaving it to recover'; exit 0 }

# 3. Port still held? A launcher-less node (started by hand) can hang while keeping
#    :3000 bound — a fresh launcher's node would just die EADDRINUSE every 3s forever.
#    That state needs a human (it's UptimeRobot's page), not a blind restart on top.
$held = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($held) {
  Write-Log "healthz dead but :3000 still bound by pid $($held[0].OwningProcess) - not restarting (hung unsupervised process needs a human)"
  exit 0
}

# 4. Nothing supervising, port free. Bring the launcher back (same invocation as
#    the BridgeAdvRuns logon task) and record the incident.
Write-Log 'healthz dead + no launcher process - restarting start-bridge.cmd'
Start-Process cmd.exe -ArgumentList "/c start `"Bridge Adv Runs`" /min `"$launcherCmd`"" -WorkingDirectory $dir
