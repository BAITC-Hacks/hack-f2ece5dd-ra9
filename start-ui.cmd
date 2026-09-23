@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.cmd first.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8765 in Edge or Chrome. Press Ctrl+C to stop.
.venv\Scripts\python.exe -m backend
if not errorlevel 1 exit /b 0
echo Server stopped with an error. Check whether port 8765 is in use.
pause
