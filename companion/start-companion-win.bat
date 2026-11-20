@echo off
title MyWay Moswar Companion
cd /d "%~dp0"
echo ========================================================
echo    Запуск MyWay Moswar Companion (Windows)
echo ========================================================
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Node.js не найден в системе!
    echo Скачайте и установите Node.js с официального сайта: https://nodejs.org/
    pause
    exit /b 1
)
node companion.js
pause
