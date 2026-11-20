@echo off
rem Запуск Яндекс.Браузера на Windows с отладочным портом 9222
start browser.exe --remote-debugging-port=9222 --remote-allow-origins=* "https://www.moswar.ru/travel2/"
echo Яндекс.Браузер запущен с портом отладки 9222
