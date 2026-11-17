@echo off
rem Reads your Shorts folders (never changes them), updates the HQ inventory and pushes hq/data.enc.
rem Needs HQ_PASSWORD set once: setx HQ_PASSWORD "your password"
cd /d "%~dp0..\.."
node tools\hq\hq.mjs inventory
if errorlevel 1 pause
