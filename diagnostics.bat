@echo off
cd /d "%~dp0"
call npm run diagnostics
call npm run api:check
