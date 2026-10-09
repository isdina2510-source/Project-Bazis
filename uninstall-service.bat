@echo off
rem Остановка и удаление службы сайта; после этого сайт запускается вручную через start-site.bat.
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>nul
if errorlevel 1 (
  echo Запустите этот файл от имени администратора: правый клик — «Запуск от имени администратора».
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-service.ps1" uninstall
pause
