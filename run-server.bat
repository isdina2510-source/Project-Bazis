@echo off
rem Сервер сайта с автоперезапуском: если node упадёт, через несколько секунд он запустится снова.
rem   run-server.bat          — в этом окне (вывод на экран), так его вызывает start-site.bat
rem   run-server.bat service  — для службы Windows (install-service.bat): вывод в server-run.log
chcp 65001 >nul
cd /d "%~dp0"
setlocal

set "MODE=%~1"
set "LOG=%~dp0server-run.log"
set "NODE_DIR=%~dp0.tools\node-v22.20.0-win-x64"
if exist "%NODE_DIR%\node.exe" set "PATH=%NODE_DIR%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  call :say "Node.js не найден: ни в .tools, ни в системе. Установите Node с https://nodejs.org/" "Node.js not found"
  exit /b 1
)

if not exist "node_modules" (
  call :say "Устанавливаем зависимости..." "npm install"
  call :run npm install --no-fund --no-audit
  if errorlevel 1 (
    call :say "Не удалось установить зависимости. Проверьте интернет." "npm install failed"
    exit /b 1
  )
)

rem Сборка только если её нет; после обновления кода запускайте update-site.bat.
set "NEED_BUILD="
if not exist "dist\index.html" set "NEED_BUILD=1"
if not exist "dist-media\index.html" set "NEED_BUILD=1"
if defined NEED_BUILD (
  call :say "Сайт ещё не собран — собираем..." "npm run build"
  call :run npm run build
  if errorlevel 1 (
    call :say "Сборка завершилась с ошибкой." "build failed"
    exit /b 1
  )
)

rem Защита от цикла перезапусков: сервер упал BAZIS_CRASH_LIMIT раз за BAZIS_CRASH_WINDOW с — пауза BAZIS_CRASH_PAUSE с.
rem Переменные окружения переопределяют значения только для тестов (test/run-server-bat.test.js).
if not defined BAZIS_CRASH_LIMIT set "BAZIS_CRASH_LIMIT=5"
if not defined BAZIS_CRASH_WINDOW set "BAZIS_CRASH_WINDOW=120"
if not defined BAZIS_CRASH_PAUSE set "BAZIS_CRASH_PAUSE=300"
if not defined BAZIS_RESTART_WAIT set "BAZIS_RESTART_WAIT=5"
set "CRASHES="

:loop
call :rotate
call :say "Запуск сервера" "server start"
call :run node server.js
set "CODE=%errorlevel%"

rem 0 — штатная остановка (Ctrl+C); перезапускать не нужно.
if "%CODE%"=="0" (
  call :say "Сервер остановлен." "server stopped"
  exit /b 0
)

rem 4 — ошибка настроек в .env: перезапуск не поможет, пока файл не исправят.
if "%CODE%"=="4" (
  call :say "Сервер не запущен из-за настроек в .env — причина выше. Исправьте .env и запустите снова." "config error in .env, see message above; not restarting"
  exit /b 4
)

rem 5 — данные перенесены в Docker (data\DATA-MOVED.txt): эта копия устарела, перезапуск только навредит.
if "%CODE%"=="5" (
  call :say "Сайт работает в Docker — запускайте его через start-site.bat. Вернуться на запуск без Docker: switch-to-windows.bat." "data moved to Docker, see data\DATA-MOVED.txt; not restarting"
  exit /b 5
)

set "WAIT=%BAZIS_RESTART_WAIT%"
if "%CODE%"=="3" (
  if /i not "%MODE%"=="service" (
    call :say "Порт уже занят: сайт запущен в другом окне или службой. Это окно можно закрыть." "port in use"
    exit /b 3
  )
  set "WAIT=30"
)
call :crashcheck
if not errorlevel 1 goto restart
set "CRASHES="
call :say "Сервер упал %BAZIS_CRASH_LIMIT% раз за %BAZIS_CRASH_WINDOW% с и не может работать - причина в сообщениях выше. Пауза %BAZIS_CRASH_PAUSE% с, затем новые попытки." "server crashed %BAZIS_CRASH_LIMIT% times within %BAZIS_CRASH_WINDOW% s - pausing %BAZIS_CRASH_PAUSE% s before next attempts"
set /a "PAUSE_PINGS=BAZIS_CRASH_PAUSE+1"
ping -n %PAUSE_PINGS% 127.0.0.1 >nul
call :say "Пауза окончена - снова запускаю сервер." "pause over, starting again"
goto loop

:restart
call :say "Сервер остановился с кодом %CODE%. Перезапуск через %WAIT% с..." "server exited with code %CODE%, restart in %WAIT% s"
rem ping вместо timeout: timeout не работает без консоли (в службе).
ping -n %WAIT% 127.0.0.1 >nul
goto loop

:crashcheck
rem CRASHES — время падений в секундах за последние BAZIS_CRASH_WINDOW с; код 1 — падений набралось BAZIS_CRASH_LIMIT.
set "NOW="
for /f %%T in ('node -e "process.stdout.write(String(Math.floor(Date.now()/1000)))"') do set "NOW=%%T"
if not defined NOW exit /b 0
set "RECENT="
set "COUNT=0"
for %%T in (%CRASHES% %NOW%) do call :crashkeep %%T
set "CRASHES=%RECENT%"
if %COUNT% GEQ %BAZIS_CRASH_LIMIT% exit /b 1
exit /b 0

:crashkeep
set /a "AGE=NOW-%~1"
if %AGE% GTR %BAZIS_CRASH_WINDOW% exit /b 0
set "RECENT=%RECENT% %~1"
set /a "COUNT+=1"
exit /b 0

:run
rem call — иначе npm.cmd не вернёт управление в этот файл.
if /i "%MODE%"=="service" (
  call %* >>"%LOG%" 2>&1
) else (
  call %*
)
exit /b %errorlevel%

:say
rem %1 — для окна, %2 — для журнала службы: echo в файл пишет в кодировке консоли, поэтому там только ASCII.
if /i "%MODE%"=="service" (
  >>"%LOG%" echo === [%date% %time%] %~2
) else (
  echo [%date% %time%] %~1
)
exit /b 0

:rotate
rem Лог службы больше 10 МБ — в server-run.old.log (предыдущий старый удаляется).
if /i not "%MODE%"=="service" exit /b 0
if not exist "%LOG%" exit /b 0
for %%F in ("%LOG%") do if %%~zF GTR 10485760 move /y "%LOG%" "%~dp0server-run.old.log" >nul
exit /b 0
