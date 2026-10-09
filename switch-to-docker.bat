@echo off
rem Перенос данных сайта (база, документы, загруженные картинки) из папки data в Docker и включение автозапуска.
rem Папка data после переноса помечается устаревшей — сайт без Docker на ней больше не запустится.
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\switch-data.ps1" to-docker
if errorlevel 1 (
  echo Перенос не выполнен — причина выше.
  pause
  exit /b 1
)
pause
