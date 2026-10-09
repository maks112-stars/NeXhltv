@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js LTS is required. Install it from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
set "PROJECT_DIR=%~dp0"
set "DATA_DIR=%PROJECT_DIR%storage"
cd /d "%PROJECT_DIR%app"
for /f %%P in ('node find-server.js') do set "PORT=%%P"
if not defined PORT (
  for /f %%P in ('node find-port.js') do (
    set "PORT=%%P"
    set "HOST=127.0.0.1"
    start "Nexhltv server" /min node server.js
    timeout /t 2 /nobreak >nul
  )
)
if not defined PORT (
  echo No free port found between 3001 and 3010.
  pause
  exit /b 1
)
start "" "http://localhost:%PORT%/"
