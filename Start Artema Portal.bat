@echo off
rem Double-click to set up or open Artema Portal. Needs Python 3.9+ (python.org, tick "Add to PATH").
cd /d "%~dp0"
where pyw >nul 2>nul && (start "" pyw -3 artema_portal.py & exit /b)
where pythonw >nul 2>nul && (start "" pythonw artema_portal.py & exit /b)
echo.
echo  Artema Portal needs Python, and it isn't installed on this computer yet.
echo  Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo  then double-click this file again.
echo.
pause
