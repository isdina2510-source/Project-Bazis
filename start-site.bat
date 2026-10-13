@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Данные перенесены в Docker (switch-to-docker.bat): запускаем сайт там, а не на устаревшей папке data.
if exist "data\DATA-MOVED.txt" goto docker

echo.
echo Запуск сайта Dinara BILab...
echo Сайт:     http://127.0.0.1:8787
echo Медиа:    http://media.localhost:8787
echo Админка:  http://127.0.0.1:8787/admin.html
echo.
echo Не закрывайте это окно, пока пользуетесь сайтом. Если сервер упадёт, он перезапустится сам.
echo Сайт пересобирается только при первом запуске; после обновления кода запустите update-site.bat.
echo Для постоянной работы без окна установите службу: install-service.bat (от имени администратора).
echo.

start "" "http://127.0.0.1:8787"
call "%~dp0run-server.bat"
pause
exit /b

:docker
echo.
echo Сайт работает в Docker. Запускаем Docker Desktop и сайт, это может занять пару минут...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-autostart.ps1" logon
if errorlevel 1 goto docker_failed
echo.
echo Сайт:     http://127.0.0.1:8787
echo Медиа:    http://media.localhost:8787
echo Админка:  http://127.0.0.1:8787/admin.html
echo Окно можно закрыть: сайт работает в Docker и без него.
start "" "http://127.0.0.1:8787"
pause
exit /b 0

:docker_failed
echo.
echo Сайт в Docker не запустился. Подробности: logs\docker-autostart.log и команда docker compose logs --tail 50
pause
exit /b 1
