@echo off
REM start-bridge.cmd — supervised launcher for The Bridge Adv Runs.
REM Runs the app and RELAUNCHES it automatically if it ever exits (crash, PC
REM sleep, unhandled error). Use THIS on a real Friday instead of a bare
REM `npm start` so a hiccup can't take the check-in offline unattended.
REM Everything it prints is ALSO appended to launcher.log for troubleshooting.
REM To stop for good: close this window.
title The Bridge Adv Runs  --  KEEP THIS WINDOW OPEN
cd /d "%~dp0"
echo ==================================================================
echo   The Bridge Adv Runs is starting up.
echo   KEEP THIS WINDOW OPEN. Closing it stops the check-in app.
echo   (Live output below is also saved to launcher.log)
echo ==================================================================
echo.
:loop
echo [%date% %time%] Starting The Bridge Adv Runs...  >> launcher.log
echo [%date% %time%] Starting The Bridge Adv Runs...
REM Run node directly (no dependency on npm being on PATH). Tee output to the
REM log so problems are visible on screen AND recorded for debugging.
node --env-file-if-exists=.env server.js >> launcher.log 2>&1
echo.
echo [%date% %time%] Server stopped (exit code %errorlevel%). Restarting in 3s...
echo [%date% %time%] Server stopped (exit code %errorlevel%). Restarting in 3s... >> launcher.log
echo Close this window now if you meant to stop it.
timeout /t 3 /nobreak >nul
goto loop
