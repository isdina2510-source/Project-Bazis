@echo off
rem Автозапуск сайта в Docker при входе в Windows и перезапуск Docker Desktop, если он закрылся или упал.
rem Права администратора не нужны: задачи создаются для текущего пользователя.
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-autostart.ps1" install
if errorlevel 1 (
  echo Не удалось установить автозапуск.
  pause
  exit /b 1
)
echo.
echo Docker Desktop работает только после входа в Windows: без входа сайт не запустится.
echo Удаление автозапуска: uninstall-docker-autostart.bat.
pause
