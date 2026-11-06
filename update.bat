@echo off
cd /d "%~dp0"
where git >nul 2>nul && git pull
call npm install
call npm run build
