@echo off
rem Восстановление данных сайта из копии. Без параметра — самая свежая копия; другую — перетащите её папку
rem на этот файл или: restore-backup.bat "D:\Bazis-backups\bazis-2026-10-09_03-00-00".
rem Перед восстановлением спросит подтверждение, текущие данные сохранит в data-before-restore-<дата>.
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\offsite-backup.ps1" restore -From "%~1"
pause
