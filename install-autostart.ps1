# install-autostart.ps1 — one-time setup so The Bridge Adv Runs starts itself
# automatically every time you log in (and after any reboot). Needs admin, which
# is why it's a separate script you run once. After this you never touch it again.
#
# HOW TO RUN (once):
#   Right-click this file  ->  "Run with PowerShell"  ->  approve the admin prompt.
#   (If right-click doesn't offer that: open PowerShell as Administrator and run
#    powershell -ExecutionPolicy Bypass -File "E:\YA Bridge Runs\bridge-runs\install-autostart.ps1")

$ErrorActionPreference = 'Stop'

# Self-elevate if not already running as admin.
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $admin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Yellow
  Start-Process powershell.exe "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
  return
}

$dir = 'E:\YA Bridge Runs\bridge-runs'
$action   = New-ScheduledTaskAction -Execute 'cmd.exe' `
              -Argument '/c start "Bridge Adv Runs" /min start-bridge.cmd' -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'BridgeAdvRuns' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'The Bridge Adv Runs check-in app - auto-start at login' -Force | Out-Null

Write-Host ""
Write-Host "DONE. 'BridgeAdvRuns' will now start automatically every time you log in." -ForegroundColor Green
Write-Host "It launches minimized; find it on the taskbar. To undo: run" -ForegroundColor Gray
Write-Host "  Unregister-ScheduledTask -TaskName BridgeAdvRuns -Confirm:`$false" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
