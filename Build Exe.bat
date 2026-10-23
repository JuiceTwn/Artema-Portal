@echo off
rem Builds dist\ArtemaPortal.exe: one file, no Python needed on the machines that run it.
rem Run this once on a computer that has Python 3.9+ installed.
cd /d "%~dp0"
set PY=py -3
where py >nul 2>nul || set PY=python
%PY% -m pip install --quiet --upgrade pyinstaller || goto fail
%PY% -m PyInstaller --noconfirm --clean --onefile --noconsole --name ArtemaPortal ^
  --icon web\assets\icon.ico --add-data "web;web" artema_portal.py || goto fail
echo.
echo  Done. Your app is: %~dp0dist\ArtemaPortal.exe
echo  Copy that one file to any computer and double-click it.
pause
exit /b
:fail
echo.
echo  Build failed. Is Python installed and on PATH?
pause
