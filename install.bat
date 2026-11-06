@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo [ERROR] Node.js not found. Install the LTS version from https://nodejs.org ^(tick "Add to PATH"^), then reopen this window. & exit /b 1)
where npm >nul 2>nul || (echo [ERROR] npm not found on PATH. Reinstall Node.js and tick "Add to PATH". & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node -v') do set NV=%%v
set NV=%NV:v=%
if %NV% LSS 20 (echo [ERROR] Node.js 20.19 or newer required. Found:& node -v & exit /b 1)
echo Installing dependencies...
call npm install
if errorlevel 1 (echo [ERROR] npm install failed. Run diagnostics.bat and see docs\WINDOWS_SETUP.md & exit /b 1)
if not exist .env if exist .env.example copy .env.example .env >nul
call npm run diagnostics
if errorlevel 1 exit /b 1
echo.
echo ETI installed. Run start.bat to launch.
