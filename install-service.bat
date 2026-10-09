@echo off
rem Установка сайта как службы Windows: запуск при старте компьютера и автоперезапуск при падении.
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>nul
if errorlevel 1 (
  echo Запустите этот файл от имени администратора: правый клик — «Запуск от имени администратора».
  pause
  exit /b 1
)

echo Если сайт открыт в окне start-site.bat, сервер в нём будет остановлен — дальше сайт работает как служба.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-service.ps1" install
if errorlevel 1 (
  echo Не удалось установить службу.
  pause
  exit /b 1
)
echo.
echo Обновление кода: update-site.bat. Удаление службы: uninstall-service.bat.
pause
