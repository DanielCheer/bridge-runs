' watchdog-hidden.vbs — run watchdog.ps1 with NO console window at all.
' A scheduled task that launches powershell.exe directly always flashes a conhost
' window in the user's session, even with -WindowStyle Hidden (the console is
' created first, hidden after). wscript is a GUI-subsystem host, so nothing ever
' appears. Registered as the BridgeAdvRunsWatchdog action 2026-08-04 after the
' owner reported the 5-minute flashing.
' watchdog.ps1 sits next to this file; its path is derived so the checkout can live anywhere.
Dim here
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run _
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\watchdog.ps1""", 0, False
