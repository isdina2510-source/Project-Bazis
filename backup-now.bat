@echo off
rem Копия данных сайта прямо сейчас — в папки, заданные в install-backup.bat. Состояние копий: backup-now.bat status.
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="status" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" status
  pause
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" run
if errorlevel 1 echo Копия не сделана — причина выше и в logs\backup.log.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" status
pause
