@echo off
rem Ежедневная копия базы, документов и картинок из Docker в обычные папки Windows (03:00) и сразу первая копия.
rem Папки можно указать: install-backup.bat "D:\Bazis-backups;E:\Копии" — иначе выбирается второй диск (D:) или «Документы».
rem Права администратора не нужны.
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" install -Target "%~1"
if errorlevel 1 (
  echo Копия не сделана — причина выше и в logs\backup.log.
  pause
  exit /b 1
)
echo.
echo Сделать копию сейчас: backup-now.bat. Восстановить: restore-backup.bat.
pause
