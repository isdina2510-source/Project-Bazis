@echo off
rem Автоматический вход в Windows: после перезагрузки сайт в Docker запустится без человека, экран сразу заблокируется.
rem Пароль вводится в окне утилиты Microsoft Autologon и хранится зашифрованным.
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>nul
if errorlevel 1 (
  echo Запустите этот файл от имени администратора: правый клик — «Запуск от имени администратора».
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-autologon.ps1" enable
pause
