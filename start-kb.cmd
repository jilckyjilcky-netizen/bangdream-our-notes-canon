@echo off
rem BanG Dream! Our Notes KB - one-click launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-kb.ps1" %*
if errorlevel 1 pause
