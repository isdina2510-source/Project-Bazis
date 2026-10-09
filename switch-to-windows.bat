@echo off
rem Возврат данных сайта из Docker в папку data (запуск через start-site.bat или службу install-service.bat).
rem Автозапуск Docker выключается, данные в Docker помечаются устаревшими.
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\switch-data.ps1" to-windows
if errorlevel 1 (
  echo Перенос не выполнен — причина выше.
  pause
  exit /b 1
)
pause
