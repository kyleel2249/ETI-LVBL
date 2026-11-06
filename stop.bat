@echo off
rem Stops whatever is listening on ETI's port 4173.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :4173 ^| findstr LISTENING') do taskkill /PID %%p /F
echo Done.
