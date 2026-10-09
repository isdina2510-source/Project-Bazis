@echo off
rem После обновления кода: зависимости, сборка обоих сайтов и перезапуск службы (если установлена).
chcp 65001 >nul
cd /d "%~dp0"
setlocal

set "TASK=Bazis Site"
rem Данные в Docker (switch-to-docker.bat): пересобираем образ — тесты и сборка идут внутри Docker.
if exist "data\DATA-MOVED.txt" goto docker
set "NODE_DIR=%~dp0.tools\node-v22.20.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден: ни в .tools, ни в системе.
  pause
  exit /b 1
)

echo Обновляем зависимости...
call npm install --no-fund --no-audit
if errorlevel 1 (
  if not exist "node_modules" (
    echo Не удалось установить зависимости. Проверьте интернет.
    pause
    exit /b 1
  )
  echo Не удалось обновить зависимости — собираем с уже установленными.
)

echo Собираем сайты Базис и Базис Медиа...
call npm run build
if errorlevel 1 (
  echo Сборка завершилась с ошибкой. Работающий сервер не трогаем.
  pause
  exit /b 1
)

schtasks /query /tn "%TASK%" >nul 2>nul
if errorlevel 1 (
  echo.
  echo Готово. Если сайт запущен в окне start-site.bat — закройте его и запустите снова,
  echo чтобы применились изменения сервера.
  pause
  exit /b 0
)

echo Перезапускаем службу "%TASK%"...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-service.ps1" restart
if errorlevel 1 (
  echo Не удалось перезапустить службу — запустите этот файл от имени администратора.
  pause
  exit /b 1
)
echo Готово.
pause
exit /b 0

:docker
echo Пересобираем сайт в Docker: тесты, сборка, перезапуск...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-autostart.ps1" watch
if errorlevel 1 goto docker_failed
rem Свежая копия данных до обновления (новая версия может менять структуру базы); без неё не обновляем.
schtasks /query /tn "Bazis Backup" >nul 2>nul
if errorlevel 1 goto docker_build
echo Копия данных перед обновлением...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" run
if errorlevel 1 (
  echo Копия данных не сделана — обновление отменено, сайт работает как раньше. Причина выше и в logs\backup.log.
  pause
  exit /b 1
)
:docker_build
docker compose up -d --build
if errorlevel 1 goto docker_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-autostart.ps1" logon
if errorlevel 1 goto docker_failed
echo Готово: сайт в Docker обновлён.
pause
exit /b 0

:docker_failed
echo Обновление не удалось. Если упали тесты или сборка, работающий сайт не заменён.
echo Подробности выше, в logs\docker-autostart.log и в docker compose logs --tail 50
pause
exit /b 1
