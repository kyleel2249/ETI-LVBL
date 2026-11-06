@echo off
cd /d "%~dp0"
if not exist node_modules (echo Dependencies missing - run install.bat first. & exit /b 1)
call npm start
