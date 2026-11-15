@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
    py -3.11 start_dashboard.py
) else (
    python start_dashboard.py
)
if errorlevel 1 pause
