@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  echo Open http://127.0.0.1:8765 in your browser. Press Ctrl+C to stop.
  py -3 -m http.server 8765 --bind 127.0.0.1 --directory ui
  exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
  echo Open http://127.0.0.1:8765 in your browser. Press Ctrl+C to stop.
  python -m http.server 8765 --bind 127.0.0.1 --directory ui
  exit /b
)
echo Python 3 is not installed. You can open ui\index.html directly in a browser.
pause
